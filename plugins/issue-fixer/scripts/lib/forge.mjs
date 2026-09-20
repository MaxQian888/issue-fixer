// Forge adapter — creates the reviewable change request (MR/PR) on the repo's platform.
// Types:
//   git     — always available fallback: reports the push + "create MR" instructions and
//             returns { deployPending: true } instead of faking a created MR.
//   github  — `gh pr create` / `gh pr list --head` dedup / `gh pr checks` for CI
//             (needs gh on PATH + `gh auth login`). forge.repo is auto-detected from
//             the origin remote when unset — git@github.com:owner/name(.git) or
//             https://github.com/owner/name both work, so GitHub repos need zero config.
//   custom  — run forge.mrCommand / forge.mrListCommand templates with {repo} {head}
//             {base} {title} {bodyFile} {draft} substitution. This is how other
//             forges plug in, e.g. GitLab:
//               mrCommand:   'glab mr create -R {repo} --source-branch {head}
//                             --target-branch {base} --title {title} --description-file {bodyFile} --draft'
//               mrListCommand: 'glab mr list -R {repo} --source-branch {head} --output json'
//             mrListCommand prints a JSON array of open MRs for the head branch.
import { execFileSync } from 'node:child_process'
import { renderTemplate } from './config.mjs'

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts })

const runShell = (command, opts = {}) =>
  execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts })

export const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

function gitForge() {
  const findExisting = () => null
  const createMR = (o) => ({
    deployPending: true,
    reason: 'forge.type=git — no MR platform configured',
    command: `git push -u origin ${o.head}`,
    note:
      'The branch is pushed; create the MR/PR on the repo\'s platform (or set forge.type=github / ' +
      'forge.mrCommand). Reviewers: map tracker identities to platform user ids where the forge runs.',
  })
  return { type: 'git', findExisting, createMR }
}

/** Parse owner/name from a GitHub remote URL (ssh or https). */
export function parseGithubRepo(url) {
  const m = /github\.com[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(String(url || '').trim())
  return m ? m[1] : null
}

/** forge.repo, falling back to the origin remote of the given checkout. */
function githubRepo(cfg, cwd) {
  if (cfg.forge.repo) return cfg.forge.repo
  try {
    return parseGithubRepo(run('git', ['remote', 'get-url', 'origin'], { cwd: cwd || cfg.repoDir }))
  } catch {
    return null // gh resolves the repo from the local checkout itself
  }
}

function githubForge(cfg) {
  const repoArgs = (cwd) => {
    const repo = githubRepo(cfg, cwd)
    return repo ? ['-R', repo] : []
  }
  const findExisting = (head, cwd) => {
    try {
      const out = run('gh', ['pr', 'list', '--head', head, '--state', 'open', '--json', 'number,url', ...repoArgs(cwd)], { cwd })
      const hit = JSON.parse(out)?.[0]
      return hit ? { iid: hit.number, url: hit.url } : null
    } catch {
      return null
    }
  }
  const createMR = (o) => {
    const existing = findExisting(o.head, o.cwd)
    if (existing) {
      // Keep the open PR accurate instead of silently returning it.
      const edit = ['pr', 'edit', String(existing.iid)]
      if (o.title) edit.push('--title', o.title)
      if (o.bodyFile) edit.push('--body-file', o.bodyFile)
      else if (o.body) edit.push('--body', o.body)
      if (edit.length > 3) {
        try {
          run('gh', [...edit, ...repoArgs(o.cwd)], { cwd: o.cwd })
        } catch { /* edit is best-effort; the PR already exists */ }
      }
      return { ok: true, existed: true, url: existing.url, iid: existing.iid }
    }
    const argv = ['pr', 'create', '--title', o.title, '--head', o.head, '--base', o.base]
    if (o.bodyFile) argv.push('--body-file', o.bodyFile)
    else if (o.body) argv.push('--body', o.body)
    if (o.draft) argv.push('--draft')
    if (o.reviewers?.length) argv.push('--reviewer', o.reviewers.join(','))
    const out = run('gh', [...argv, ...repoArgs(o.cwd)], { cwd: o.cwd })
    return { ok: true, url: out.trim().split('\n').pop(), raw: out }
  }
  // CI follow-up: `gh pr checks` gives per-check buckets without polling internals.
  const checks = (head, cwd) => {
    try {
      const out = run('gh', ['pr', 'checks', head, '--json', 'name,state,bucket,link', ...repoArgs(cwd)], { cwd })
      const list = JSON.parse(out) || []
      const by = (b) => list.filter((c) => c.bucket === b)
      return {
        ok: true,
        total: list.length,
        passing: by('pass'),
        pending: [...by('pending'), ...by('skipping')],
        failing: [...by('fail'), ...by('cancel')],
      }
    } catch (e) {
      return { ok: false, reason: (e.stderr || e.message || '').trim().slice(0, 300) }
    }
  }
  return { type: 'github', findExisting, createMR, checks }
}

function customForge(cfg) {
  const { mrCommand, mrListCommand, repo } = cfg.forge
  if (!mrCommand) throw new Error('forge.type=custom requires forge.mrCommand (or FIXER_MR_COMMAND)')
  const findExisting = (head) => {
    if (!mrListCommand) return null
    try {
      const out = runShell(renderTemplate(mrListCommand, { repo, head }))
      const items = JSON.parse(out)
      const list = Array.isArray(items) ? items : items?.data?.merge_requests || items?.data?.items || []
      const hit = list.find((m) => [m.SourceBranchName, m.source_branch, m.head].includes(head))
      return hit ? { iid: hit.Number ?? hit.iid ?? hit.number, url: hit.URL ?? hit.web_url ?? hit.WebURL } : null
    } catch {
      return null
    }
  }
  const createMR = (o) => {
    const existing = findExisting(o.head)
    if (existing) return { ok: true, existed: true, url: existing.url, iid: existing.iid }
    const command = renderTemplate(mrCommand, {
      repo,
      head: o.head,
      base: o.base,
      title: o.title,
      bodyFile: o.bodyFile || '',
      draft: o.draft ? 'true' : 'false',
    })
    const out = runShell(command)
    let url
    try {
      const parsed = JSON.parse(out)
      const mr = parsed?.data?.merge_request || parsed?.data || parsed
      url = mr.URL ?? mr.web_url ?? mr.WebURL ?? mr.url
    } catch {
      url = out.trim().split('\n').find((line) => /^https?:\/\//.test(line))
    }
    return { ok: true, url, raw: out.trim().slice(0, 2000), command }
  }
  return { type: 'custom', findExisting, createMR }
}

export function getForge(cfg) {
  switch (cfg.forge.type) {
    case 'git':
      return gitForge(cfg)
    case 'github':
      return githubForge(cfg)
    case 'custom':
      return customForge(cfg)
    default:
      throw new Error(`unknown forge type "${cfg.forge.type}" — supported: git | github | custom`)
  }
}
