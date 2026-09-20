// Create a reviewable change request (MR/PR) through the configured forge adapter
// (scripts/lib/forge.mjs). If the forge can't run here, it does NOT fake success: it
// prints the exact command and returns { deployPending: true } so the orchestrator
// surfaces "needs the forge environment".
//
// Assumes the fix branch is already committed & pushed. Target = FIXER_BASE_BRANCH
// (default main), Draft on.
//
// CLI: node mr.mjs create --head fix/agent-x --base main --title "..." \
//        --body-file body.md [--reviewers a,b] [--no-draft]
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
  if (a[0] !== 'create') {
    console.error('usage: mr.mjs create --head <b> --base <b> --title <t> [--body-file f] [--reviewers a,b] [--no-draft]')
    process.exit(2)
  }
  const cfg = getConfig()
  const bodyFile = flag('body-file')
  const res = getForge(cfg).createMR({
    repo: cfg.forge.repo,
    head: flag('head'),
    base: flag('base', cfg.baseBranch),
    title: flag('title'),
    body: bodyFile ? readFileSync(bodyFile, 'utf8') : flag('body', ''),
    bodyFile,
    reviewers: (flag('reviewers', '') || '').split(',').filter(Boolean),
    draft: !a.includes('--no-draft'),
  })
  console.log(JSON.stringify(res, null, 2))
}
