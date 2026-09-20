// Detached dev-server lifecycle for the `local-dev` capture lane.
// Turns "keep a dev server warm" from prose into something with a handle:
// the pidfile lives at <runDir>/dev-server.json, so a later stop — or a sweep
// from a future session — can reclaim the process instead of leaking it.
//
// CLI:
//   node devserver.mjs start <runDir> [--cwd <worktree>] [--url <entry>] [--timeout 60]
//   node devserver.mjs status <runDir>
//   node devserver.mjs stop <runDir>
//   node devserver.mjs sweep [--artifacts-dir <dir>]   (default: cfg.artifactsDir)
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { getConfig } from './lib/config.mjs'

const PIDFILE = 'dev-server.json'

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Args of a live pid (pid-reuse guard before we ever signal it). */
const pidArgs = (pid) => {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const readPidfile = (runDir) => {
  const file = join(runDir, PIDFILE)
  if (!existsSync(file)) return null
  try {
    return { file, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    return null
  }
}

const waitForUrl = async (url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (res.status < 500) return true
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return false
}

/** True when the live process still looks like the recorded dev-server command. */
const pidMatches = (meta) => {
  if (!meta?.pid || !pidAlive(meta.pid)) return false
  const args = pidArgs(meta.pid)
  if (!args) return false
  // The command's first meaningful token (e.g. `pnpm`) must appear in the live args.
  const token = (meta.command || '').split(/\s+/).filter(Boolean)[0]
  return token ? args.includes(token) : true
}

export async function startDevServer(runDir, { cwd, url, timeoutMs = 60_000, cfg = getConfig() } = {}) {
  const command = cfg.capture?.devServerCommand
  if (!command) throw new Error('devserver: capture.devServerCommand is not configured')
  const entry = url || cfg.capture?.productEntryUrl || 'http://localhost:3000'
  const existing = readPidfile(runDir)
  if (existing && pidAlive(existing.pid) && pidMatches(existing)) {
    return { ok: true, reused: true, pid: existing.pid, url: existing.url }
  }
  mkdirSync(runDir, { recursive: true })
  const log = join(runDir, 'dev-server.log')
  const child = spawn('sh', ['-c', command], {
    cwd: cwd || cfg.repoDir || process.cwd(),
    detached: true,
    stdio: ['ignore', createWriteStream(log), createWriteStream(log)],
    env: { ...process.env, NODE_ENV: 'development' },
  })
  child.unref()
  const meta = {
    pid: child.pid,
    cwd: cwd || cfg.repoDir || process.cwd(),
    command,
    url: entry,
    startedAt: new Date().toISOString(),
    log,
  }
  writeFileSync(join(runDir, PIDFILE), JSON.stringify(meta, null, 2))
  const up = await waitForUrl(entry, timeoutMs)
  return up
    ? { ok: true, pid: child.pid, url: entry, log }
    : { ok: false, pid: child.pid, url: entry, log, reason: `no response at ${entry} within ${Math.round(timeoutMs / 1000)}s — see dev-server.log` }
}

export function devServerStatus(runDir) {
  const meta = readPidfile(runDir)
  if (!meta) return { running: false }
  return { running: pidAlive(meta.pid) && pidMatches(meta), ...meta }
}

export function stopDevServer(runDir) {
  const meta = readPidfile(runDir)
  if (!meta) return { stopped: false, reason: 'no_pidfile' }
  if (pidAlive(meta.pid) && pidMatches(meta)) {
    try {
      process.kill(-meta.pid, 'SIGTERM') // detached group kill — children go too
    } catch {
      try { process.kill(meta.pid, 'SIGTERM') } catch { /* already gone */ }
    }
  }
  rmSync(meta.file, { force: true })
  return { stopped: true, pid: meta.pid }
}

/**
 * Reclaim dev servers from previous runs. A pidfile is only honoured while the
 * recorded pid is alive AND its args still match the recorded command — a reused
 * pid is reported, never signalled.
 */
export function sweepDevServers(artifactsDir) {
  if (!artifactsDir || !existsSync(artifactsDir)) return { swept: [] }
  const out = []
  for (const entry of readdirSync(artifactsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const runDir = join(artifactsDir, entry.name)
    const meta = readPidfile(runDir)
    if (!meta) continue
    if (pidAlive(meta.pid) && pidMatches(meta)) {
      stopDevServer(runDir)
      out.push({ runDir, pid: meta.pid, action: 'killed' })
    } else {
      rmSync(meta.file, { force: true })
      out.push({ runDir, pid: meta.pid, action: 'stale-pidfile-removed' })
    }
  }
  return { swept: out }
}

/** Cheap check for hooks: any pidfiles under the artifacts dir at all? */
export function hasPidfiles(artifactsDir) {
  try {
    return readdirSync(artifactsDir, { withFileTypes: true })
      .some((e) => e.isDirectory() && existsSync(join(artifactsDir, e.name, PIDFILE)))
  } catch {
    return false
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const [cmd, runDir] = process.argv.slice(2)
  const flag = (n, d) => {
    const i = process.argv.indexOf(`--${n}`)
    return i >= 0 ? process.argv[i + 1] : d
  }
  const cfg = getConfig()
  const run = async () => {
    if (cmd === 'start') return startDevServer(runDir, { cwd: flag('cwd'), url: flag('url'), timeoutMs: Number(flag('timeout', 60)) * 1000 })
    if (cmd === 'status') return devServerStatus(runDir)
    if (cmd === 'stop') return stopDevServer(runDir)
    if (cmd === 'sweep') return sweepDevServers(flag('artifacts-dir', cfg.artifactsDir))
    throw new Error('usage: devserver.mjs start|status|stop <runDir> | sweep [--artifacts-dir d]')
  }
  run()
    .then((res) => console.log(JSON.stringify(res, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1) })
}
