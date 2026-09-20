// Thin wrapper around the `lark-cli` binary used by the lark-base tracker adapter, the
// lark notify adapter, and the lark-docx report sink. Every lark-cli call goes through
// here so identity, JSON parsing, error CLASSIFICATION, and rate-limit retry are
// consistent — and so the agent gets an actionable message it can act on (switch
// identity, apply a scope, mark deploy-pending) instead of a generic failure.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const larkBin = () => process.env.LARK_CLI_BIN || 'lark-cli'

// Feishu rate-limit / concurrent-write codes worth retrying.
const RETRYABLE_CODES = new Set(['99991400', '230020', '1254291'])

export class LarkError extends Error {
  constructor(message, info = {}) {
    super(message)
    this.name = 'LarkError'
    Object.assign(this, info) // kind, hint, missingScopes, code, subtype, applyUrl, ...
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Turn a failed lark-cli envelope into { kind, hint, missingScopes, applyUrl, code, ... }. */
export function classifyLarkError(env) {
  const e = (env && env.error) || {}
  const code = String(e.code ?? '')
  const sub = e.subtype || ''
  const type = e.type || ''
  const msg = e.message || JSON.stringify(e)
  const missing = e.missing_scopes || (e.permission_violations || []).map((v) => v.scope).filter(Boolean) || []
  const applyUrl = e.console_url || ''
  let kind = 'unknown'
  let hint = e.hint || ''
  if (missing.length || applyUrl || /\bscope\b/i.test(msg)) {
    kind = 'scope'
    hint = hint || (applyUrl ? `apply scope: ${applyUrl}` : `missing scopes: ${missing.join(', ') || 'unknown'} — apply via lark-shared`)
  } else if (code === '91403' || sub === 'permission' || /permission|forbidden|\b403\b/i.test(msg)) {
    kind = 'permission'
    hint = hint || 'no access to this resource; try the other identity (--as user|bot) or request access via lark-shared'
  } else if (RETRYABLE_CODES.has(code) || sub === 'rate_limit' || /rate.?limit|\b429\b/i.test(msg)) {
    kind = 'rate_limit'
    hint = hint || 'rate limited; retry with backoff'
  } else if (code === '1254045' || sub === 'not_found' || /not.?found/i.test(msg)) {
    kind = 'not_found'
    hint = hint || 'resource/field/record not found; re-list to get real ids (field names are case/space sensitive)'
  } else if (type === 'validation' || sub === 'invalid_argument' || code === '1254015' || code === '1254104') {
    kind = 'validation'
    hint = hint || 'bad argument/value; check field types (lark-base cell-value) and batch limits (≤200)'
  } else if (type === 'network') {
    kind = 'network'
    hint = hint || 'transport error'
  }
  return { kind, hint, missingScopes: missing, applyUrl, code, subtype: sub, type, message: msg }
}

/**
 * Run a lark-cli command; return the parsed `{ ok, data, error }` envelope.
 * Retries rate-limits with backoff. On a non-retryable failure throws a LarkError whose
 * message embeds the classification + actionable hint (unless allowError).
 */
export async function runLark(args, { as = 'user', allowError = false, retries = 3 } = {}) {
  const argv = [...args]
  if (as && !argv.includes('--as')) argv.push('--as', as)
  for (let attempt = 1; ; attempt++) {
    let stdout = ''
    let stderr = ''
    try {
      const res = await execFileAsync(larkBin(), argv, { maxBuffer: 64 * 1024 * 1024 })
      stdout = res.stdout
      stderr = res.stderr || ''
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new LarkError(`lark-cli not found (set LARK_CLI_BIN). cmd: ${larkBin()} ${argv.join(' ')}`, { kind: 'missing_bin' })
      }
      // lark-cli exits non-zero on API errors but prints the JSON envelope — on stdout OR stderr.
      stdout = err.stdout || ''
      stderr = err.stderr || ''
      if (!stdout && !stderr) throw new LarkError(`lark-cli spawn failed: ${err.message}`, { kind: 'network', cause: String(err) })
    }
    const env = parseEnvelope(stdout) || parseEnvelope(stderr)
    if (!env) return { ok: true, raw: stdout } // markdown-mode read command
    if (env.ok === false && !allowError) {
      const info = classifyLarkError(env)
      if (info.kind === 'rate_limit' && attempt <= retries) {
        await sleep(500 * attempt * attempt)
        continue
      }
      throw new LarkError(`lark-cli ${argv[0] || ''} ${argv[1] || ''} failed [${info.kind}]: ${info.message}${info.hint ? ` — ${info.hint}` : ''}`, info)
    }
    return env
  }
}

/**
 * Local lark-cli preflight: binary present, auth live, and the operator identity.
 * Pure read (`lark-cli whoami`), never throws — callers surface `ok:false` as an
 * actionable blocker instead of discovering missing auth mid-run.
 */
export async function larkWhoami() {
  try {
    const { stdout } = await execFileAsync(larkBin(), ['whoami'], { maxBuffer: 4 * 1024 * 1024 })
    const env = JSON.parse((stdout || '').trim())
    return {
      ok: env.available === true,
      available: env.available === true,
      identity: env.identity || env.defaultAs || 'user',
      openId: env.onBehalfOf?.openId || '',
      userName: env.onBehalfOf?.userName || '',
      tokenStatus: env.tokenStatus || '',
      raw: env,
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { ok: false, available: false, kind: 'missing_bin', reason: 'lark-cli not found — install it or set LARK_CLI_BIN' }
    }
    return { ok: false, available: false, kind: 'unauthenticated', reason: `lark-cli whoami failed (${(e.message || '').slice(0, 200)}) — run \`lark-cli auth login\`` }
  }
}

function parseEnvelope(text) {
  const trimmed = (text || '').trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const end = trimmed.lastIndexOf('}')
    if (end > 0) {
      try {
        return JSON.parse(trimmed.slice(0, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}
