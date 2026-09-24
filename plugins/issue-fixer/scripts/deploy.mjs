// Optional post-completion deploy / real-env helpers. Fully config-driven:
//   deploy.deployCommand   template run for `deploy`  ({branch} {env} {targets})
//   deploy.envFindCommand  template run for `find`    ({keyword})
// When the corresponding command isn't configured, returns { deployPending: true } with
// the reason instead of faking a deploy — the orchestrator surfaces it honestly.
//
// CLI: node deploy.mjs deploy --branch fix/agent-x --env <lane> [--targets web]
//      node deploy.mjs find <keyword>
import { execFileSync } from 'node:child_process'
import { getConfig, renderTemplate } from './lib/config.mjs'
import { isMainModule } from './lib/is-main.mjs'

export function deployEnv(o, { cfg = getConfig() } = {}) {
  const { branch, env, targets = ['web'] } = o
  const command = cfg.deploy.deployCommand
  if (!command) {
    return {
      deployPending: true,
      reason: 'deploy.deployCommand not configured (FIXER_DEPLOY_COMMAND)',
      note: 'Deploys run through the project\'s own pipeline CLI; configure the template or trigger it where the deploy toolchain is installed.',
    }
  }
  const rendered = renderTemplate(command, { branch, env, targets: targets.join(',') })
  const out = execFileSync('/bin/sh', ['-c', rendered], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    parsed = { raw: out }
  }
  return { ok: true, env, command: rendered, raw: parsed }
}

/** Find a real-env lane by keyword via deploy.envFindCommand. */
export function findEnv(keyword, { cfg = getConfig() } = {}) {
  const command = cfg.deploy.envFindCommand
  if (!command) return { deployPending: true, reason: 'deploy.envFindCommand not configured' }
  const kw = String(keyword || '').trim()
  if (!kw) return { found: false, reason: 'no keyword' }
  try {
    const out = execFileSync('/bin/sh', ['-c', renderTemplate(command, { keyword: kw })], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return { found: true, keyword: kw, raw: JSON.parse(out) }
  } catch (e) {
    return { found: false, keyword: kw, error: (e.stdout || e.stderr || e.message || '').slice(0, 200) }
  }
}

const isMain = isMainModule(import.meta.url)
if (isMain) {
  const a = process.argv.slice(2)
  const flag = (n, d) => {
    const i = a.indexOf(`--${n}`)
    return i >= 0 ? a[i + 1] : d
  }
  if (a[0] === 'find') {
    console.log(JSON.stringify(findEnv(a[1]), null, 2))
    process.exit(0)
  }
  if (a[0] !== 'deploy') {
    console.error('usage: deploy.mjs deploy --branch <b> --env <name> [--targets a,b]  |  deploy.mjs find <keyword>')
    process.exit(2)
  }
  const res = deployEnv({
    branch: flag('branch'),
    env: flag('env'),
    targets: (flag('targets', 'web') || '').split(',').filter(Boolean),
  })
  console.log(JSON.stringify(res, null, 2))
}
