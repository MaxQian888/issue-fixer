import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { spawnSync } from 'node:child_process'

import { loadConfig, assertTrackerWritable, trackerTable, renderTemplate, worktreePathFor, branchNameFor } from '../lib/config.mjs'
import { getForge, parseGithubRepo } from '../lib/forge.mjs'
import { getTracker } from '../lib/tracker.mjs'

test('config resolves defaults and merges overrides last', () => {
  const cfg = loadConfig({ repoDir: '/tmp/repo', baseBranch: 'develop' })

  assert.equal(cfg.target, 'scratch')
  assert.equal(cfg.baseBranch, 'develop')
  assert.equal(cfg.repoDir, '/tmp/repo')
  assert.equal(cfg.tracker.type, 'none')
  assert.equal(cfg.forge.type, 'git')
  assert.equal(cfg.notify.type, 'stdout')
  assert.equal(cfg.report.type, 'markdown')
  assert.match(cfg.artifactsDir, /\.issue-fixer-artifacts$/)
})

test('config file is loaded and env-shaped overrides win', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-config-'))
  try {
    writeFileSync(join(dir, 'fixer.config.json'), JSON.stringify({
      baseBranch: 'release',
      forge: { type: 'github', repo: 'acme/app' },
      tracker: { type: 'lark-base', baseToken: 'tok', tableId: 'tbl' },
    }))
    const cfg = loadConfig({ repoDir: dir })

    assert.equal(cfg.baseBranch, 'release')
    assert.equal(cfg.forge.type, 'github')
    assert.equal(cfg.forge.repo, 'acme/app')
    assert.equal(cfg.tracker.type, 'lark-base')
    assert.equal(cfg.tracker.fields.status, '状态')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scratch guard refuses production tracker writes without target=real', () => {
  const prod = loadConfig({
    repoDir: '/tmp/repo',
    tracker: { type: 'lark-base', baseToken: 'REAL', tableId: 'tblReal' },
  })
  assert.throws(() => assertTrackerWritable(prod), /scratch-guard/)

  const scratch = loadConfig({
    repoDir: '/tmp/repo',
    tracker: {
      type: 'lark-base',
      baseToken: 'REAL',
      tableId: 'tblReal',
      scratchBaseToken: 'SCRATCH',
      scratchTableId: 'tblScratch',
    },
  })
  assert.doesNotThrow(() => assertTrackerWritable(scratch))
  const target = trackerTable(scratch, { forWrite: true })
  assert.equal(target.baseToken, 'SCRATCH')
  assert.equal(target.scratch, true)

  const real = loadConfig({
    target: 'real',
    repoDir: '/tmp/repo',
    tracker: { type: 'lark-base', baseToken: 'REAL', tableId: 'tblReal' },
  })
  assert.doesNotThrow(() => assertTrackerWritable(real))

  assert.throws(
    () => assertTrackerWritable(loadConfig({ repoDir: '/tmp/repo' })),
    /tracker is not configured/,
  )
})

test('worktree path and branch derive from templates, not fixed names', () => {
  const cfg = loadConfig({ repoDir: '/tmp/acme-app' })
  assert.equal(worktreePathFor(cfg, 'rec123'), '/tmp/acme-app-fix-rec123')
  assert.equal(branchNameFor(cfg, 'rec123'), 'fix/agent-rec123')

  const custom = loadConfig({
    repoDir: '/tmp/acme-app',
    worktree: { dirTemplate: '{repoParent}/wt-{issueId}', branchPrefix: 'chore/' },
  })
  assert.equal(worktreePathFor(custom, 'x9'), '/tmp/wt-x9')
  assert.equal(branchNameFor(custom, 'x9'), 'chore/x9')
})

test('git forge returns deployPending instead of faking an MR', () => {
  const forge = getForge(loadConfig({ repoDir: '/tmp/repo', forge: { type: 'git' } }))

  assert.equal(forge.type, 'git')
  assert.equal(forge.findExisting('fix/agent-x'), null)
  const result = forge.createMR({ head: 'fix/agent-x', base: 'main', title: 'fix x' })
  assert.equal(result.deployPending, true)
  assert.match(result.command, /git push -u origin fix\/agent-x/)
  assert.ok(!('url' in result) || !result.url)
})

test('custom forge renders command templates and dedupes by head branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-forge-'))
  try {
    const cfg = loadConfig({
      repoDir: '/tmp/repo',
      forge: {
        type: 'custom',
        repo: 'acme/app',
        mrListCommand: `printf '[{"source_branch":"fix/agent-x","iid":7,"web_url":"https://forge/mr/7"}]'`,
        mrCommand: `printf 'https://forge/mr/new' > ${join(dir, 'created.txt')} && printf 'https://forge/mr/new'`,
      },
    })
    const forge = getForge(cfg)

    const existing = forge.findExisting('fix/agent-x')
    assert.equal(existing.iid, 7)
    assert.equal(existing.url, 'https://forge/mr/7')

    const deduped = forge.createMR({ head: 'fix/agent-x', base: 'main', title: 't' })
    assert.equal(deduped.existed, true)
    assert.equal(deduped.url, 'https://forge/mr/7')

    const created = forge.createMR({ head: 'fix/agent-y', base: 'main', title: 't' })
    assert.equal(created.ok, true)
    assert.equal(created.url, 'https://forge/mr/new')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('custom forge requires mrCommand', () => {
  assert.throws(
    () => getForge(loadConfig({ repoDir: '/tmp/repo', forge: { type: 'custom' } })),
    /requires forge\.mrCommand/,
  )
})

test('unknown forge and tracker types fail loudly', () => {
  assert.throws(
    () => getForge(loadConfig({ repoDir: '/tmp/repo', forge: { type: 'gerrit' } })),
    /unknown forge type/,
  )
  assert.throws(
    () => getTracker(loadConfig({ repoDir: '/tmp/repo', tracker: { type: 'jira' } })),
    /unknown tracker type/,
  )
})

test('tracker none returns null; direct-evidence runs need no tracker', () => {
  const tracker = getTracker(loadConfig({ repoDir: '/tmp/repo' }))
  assert.equal(tracker, null)
})

test('renderTemplate substitutes known vars and rejects unknown placeholders', () => {
  assert.equal(renderTemplate('mr create -R {repo} --head {head}', { repo: 'a/b', head: 'fix/x' }), 'mr create -R a/b --head fix/x')
  assert.throws(() => renderTemplate('{nope}', {}), /unknown template variable/)
})

test('parseGithubRepo reads owner/name from ssh and https remotes', () => {
  assert.equal(parseGithubRepo('git@github.com:acme/app.git'), 'acme/app')
  assert.equal(parseGithubRepo('git@github.com:acme/app'), 'acme/app')
  assert.equal(parseGithubRepo('https://github.com/acme/app.git'), 'acme/app')
  assert.equal(parseGithubRepo('https://github.com/acme/app'), 'acme/app')
  assert.equal(parseGithubRepo('ssh://git@github.com/acme/app.git'), 'acme/app')
  assert.equal(parseGithubRepo('https://gitlab.com/acme/app'), null)
  assert.equal(parseGithubRepo(''), null)
})

test('github forge auto-detects repo from the origin remote and exposes checks', () => {
  const repo = mkdtempSync(join(tmpdir(), 'fixer-gh-'))
  try {
    spawnSync('git', ['init', '-q'], { cwd: repo })
    spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: repo })
    const forge = getForge(loadConfig({ repoDir: repo, forge: { type: 'github' } }))

    assert.equal(forge.type, 'github')
    assert.equal(typeof forge.checks, 'function')
    // Without gh auth the call fails honestly instead of fabricating check state.
    const result = forge.checks('fix/agent-x', repo)
    assert.ok(result.ok === false || Array.isArray(result.failing))

    // git forge has no checks support; mr.mjs surfaces deployPending for it.
    const gitForge = getForge(loadConfig({ repoDir: repo, forge: { type: 'git' } }))
    assert.equal(gitForge.checks, undefined)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
