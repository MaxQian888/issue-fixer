// Cognia host plane — shared client for the `cognia-agent api` command surface.
// The host plane is broader than notification: the same CLI reaches connector_send,
// bot installations/runs, tasks, workflows, git and session APIs. Keep every call
// routed through here so bin/session resolution and error honesty stay in one place.
//
// CLI resolution order:
//   cfg.host.cogniaBin / FIXER_HOST_BIN / FIXER_COGNIA_BIN → cognia-agent on PATH →
//   <repoDir>/cli/dist/cognia-agent.mjs (the target repo's own built CLI).
// Session resolution order:
//   cfg.host.sessionId / FIXER_HOST_SESSION_ID / FIXER_COGNIA_SESSION_ID →
//   cfg.notify.cogniaSessionId (back-compat) → COGNIA_SESSION_ID.
// Host auth is the CLI's own concern: a saved host (`cognia-agent host add`) or
// COGNIA_ENDPOINT + COGNIA_SERVICE_TOKEN.
import { existsSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

/** Resolve the cognia-agent invocation: [bin, ...preArgs]. Null when unresolvable. */
export function cogniaBinFor(cfg) {
  const configured = cfg.host?.cogniaBin || cfg.notify?.cogniaBin
    || process.env.FIXER_HOST_BIN || process.env.FIXER_COGNIA_BIN
  if (configured) return [configured]
  try {
    execFileSync('cognia-agent', ['--version'], { stdio: 'ignore' })
    return ['cognia-agent']
  } catch { /* not on PATH */ }
  const dist = cfg.repoDir ? join(cfg.repoDir, 'cli', 'dist', 'cognia-agent.mjs') : ''
  if (dist && existsSync(dist)) return [process.execPath, dist]
  return null
}

/** Session the host plane should address (bound conversation for connector_send). */
export function cogniaSessionIdFor(cfg) {
  return cfg.host?.sessionId || cfg.notify?.cogniaSessionId
    || process.env.FIXER_HOST_SESSION_ID || process.env.FIXER_COGNIA_SESSION_ID
    || process.env.COGNIA_SESSION_ID || ''
}

/** The cognia host plane is in play when configured as host OR as notify backend. */
export function cogniaHostEnabled(cfg) {
  return cfg.host?.type === 'cognia' || cfg.notify?.type === 'cognia'
}

/**
 * Call a host-plane verb: `cognia-agent api call <verb> ...args --json`.
 * args is an argv tail (e.g. ['--session-id', id, '--segments', json]).
 * Throws on non-zero exit; the CLI's stderr carries actionable remediation.
 */
export async function cogniaApiCall(verb, args = [], { cfg, timeoutMs = 60_000 } = {}) {
  const bin = cogniaBinFor(cfg)
  if (!bin) {
    throw new Error(
      'cognia host plane requires cognia-agent on PATH, host.cogniaBin, or <repoDir>/cli/dist/cognia-agent.mjs',
    )
  }
  const { stdout } = await execFileAsync(
    bin[0],
    [...bin.slice(1), 'api', 'call', verb, ...args, '--json'],
    { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs },
  )
  const text = (stdout || '').trim()
  try {
    return { ok: true, result: text ? JSON.parse(text) : null, stdout: text.slice(0, 400) }
  } catch {
    return { ok: true, result: null, stdout: text.slice(0, 400) }
  }
}

/**
 * Free preflight: `api describe <verb>` resolves the contract WITHOUT a configured
 * host, so it verifies the CLI surface (bin + verb exist) before a run commits to it.
 */
export async function cogniaApiDescribe(verb, { cfg, timeoutMs = 15_000 } = {}) {
  const bin = cogniaBinFor(cfg)
  if (!bin) return { ok: false, reason: 'missing_bin', verb }
  try {
    const { stdout } = await execFileAsync(
      bin[0],
      [...bin.slice(1), 'api', 'describe', verb],
      { maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs },
    )
    return { ok: true, verb, contract: (stdout || '').trim() }
  } catch (error) {
    return { ok: false, reason: 'describe_failed', verb, error: String(error?.stderr || error.message).slice(0, 300) }
  }
}

/**
 * One-call status for hooks/docs: is the plane enabled, does the CLI resolve,
 * is a session bound, and does the delivery verb exist. Never throws.
 */
export async function cogniaHostStatus(cfg) {
  if (!cogniaHostEnabled(cfg)) return { enabled: false }
  const bin = cogniaBinFor(cfg)
  const sessionId = cogniaSessionIdFor(cfg)
  const describe = bin ? await cogniaApiDescribe('connector_send', { cfg }) : { ok: false, reason: 'missing_bin' }
  return {
    enabled: true,
    bin: !!bin,
    sessionBound: !!sessionId,
    connectorSend: describe.ok,
    blocker: !bin
      ? 'missing_bin'
      : !sessionId
        ? 'no_session'
        : !describe.ok
          ? describe.reason
          : null,
  }
}
