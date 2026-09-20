// Create a reviewable change request (MR/PR) through the configured forge adapter
// (scripts/lib/forge.mjs). If the forge can't run here, it does NOT fake success: it
// prints the exact command and returns { deployPending: true } so the orchestrator
// surfaces "needs the forge environment".
//
// Assumes the fix branch is already committed & pushed. Target = FIXER_BASE_BRANCH
// (default main), Draft on. forge.type=github auto-detects owner/name from the
// origin remote, dedupes open PRs by head branch (updating title/body on the
// existing PR), and exposes `checks` for the CI follow-up step.
//
// CLI: node mr.mjs create --head fix/agent-x --base main --title "..." \
//        --body-file body.md [--reviewers a,b] [--no-draft] [--cwd <worktree>]
//      node mr.mjs checks --head fix/agent-x [--cwd <worktree>]
import { readFileSync } from 'node:fs'
import { getConfig } from './lib/config.mjs'
import { getForge } from './lib/forge.mjs'

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const a = process.argv.slice(2)
  const flag = (n, d) => {
    const i = a.indexOf(`--${n}`)
    return i >= 0 ? a[i + 1] : d
  }
  const cfg = getConfig()
  const forge = getForge(cfg)
  const cwd = flag('cwd', cfg.repoDir || process.cwd())
  if (a[0] === 'checks') {
    if (typeof forge.checks !== 'function') {
      console.log(JSON.stringify({
        deployPending: true,
        reason: `forge.type=${cfg.forge.type} has no checks support — poll CI on the forge's own tooling`,
      }, null, 2))
      process.exit(0)
    }
    console.log(JSON.stringify(forge.checks(flag('head'), cwd), null, 2))
    process.exit(0)
  }
  if (a[0] !== 'create') {
    console.error('usage: mr.mjs create --head <b> --base <b> --title <t> [--body-file f] [--reviewers a,b] [--no-draft] [--cwd d]  |  mr.mjs checks --head <b> [--cwd d]')
    process.exit(2)
  }
  const bodyFile = flag('body-file')
  const res = forge.createMR({
    repo: cfg.forge.repo,
    head: flag('head'),
    base: flag('base', cfg.baseBranch),
    title: flag('title'),
    body: bodyFile ? undefined : flag('body', ''),
    bodyFile,
    reviewers: (flag('reviewers', '') || '').split(',').filter(Boolean),
    draft: !a.includes('--no-draft'),
    cwd,
  })
  console.log(JSON.stringify(res, null, 2))
}
