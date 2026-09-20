// Emit a `fixer:progress` marker. The block is included verbatim in assistant text so it rides
// the turn's streaming events to whatever renderer is attached (an agent-server bridge in
// deployed mode; a readable checklist locally).
// The caller must include this block in assistant text; tool stdout alone is not part of the stream.
// Statuses: pending | running | done | blocked | skipped | error.
//
// Optional: with progress.push=true (config) or FIXER_PROGRESS_PUSH=1 and a Cognia
// host bound, each emitted block is ALSO posted to the bound conversation via
// connector_send — meant for detached/bot runs where nobody watches the turn.
// Best-effort: a push failure never fails the step.
//
// CLI:
//   node progress.mjs "取证:done,定位:running,基线:pending,改码:pending,验证:pending" "修复 <issueId>"

const STATUS = {
  p: 'pending',
  r: 'running',
  d: 'done',
  b: 'blocked',
  s: 'skipped',
  e: 'error',
  pending: 'pending',
  running: 'running',
  done: 'done',
  blocked: 'blocked',
  skipped: 'skipped',
  error: 'error',
}

export function progressMarker(steps, title, marker = 'fixer:progress') {
  const norm = (steps || []).map((s) => {
    if (typeof s !== 'string') return { label: s.label, status: STATUS[s.status] || 'pending', ...(s.note ? { note: s.note } : {}) }
    const i = s.lastIndexOf(':')
    const label = (i >= 0 ? s.slice(0, i) : s).trim()
    const status = STATUS[(i >= 0 ? s.slice(i + 1) : 'pending').trim()] || 'pending'
    return { label, status }
  })
  return '```' + marker + '\n' + JSON.stringify({ ...(title ? { title } : {}), steps: norm }) + '\n```'
}

const GLYPH = { done: '✅', running: '🔄', blocked: '⛔', failed: '❌', error: '❌', skipped: '⏭', pending: '⬜' }

/** Render a progress block as compact markdown for host-plane push. */
export function progressMarkdown(steps, title) {
  const norm = (steps || []).map((s) => {
    if (typeof s !== 'string') return s
    const i = s.lastIndexOf(':')
    return { label: (i >= 0 ? s.slice(0, i) : s).trim(), status: (i >= 0 ? s.slice(i + 1) : 'pending').trim() }
  })
  const lines = norm.map((s) => `${GLYPH[s.status] || '⬜'} ${s.label}${s.note ? ` — ${s.note}` : ''}`)
  return [`**${title || 'issue-fixer 进度'}**`, ...lines].join('\n')
}

/**
 * Best-effort push of the progress block to the bound Cognia session.
 * Enabled by cfg.progressPush / FIXER_PROGRESS_PUSH=1; silently no-ops when the
 * host plane is not configured or unreachable — the marker in the turn stays
 * the authoritative signal.
 */
export async function pushProgress(steps, title, { cfg } = {}) {
  try {
    const { getConfig } = await import('./lib/config.mjs')
    const { cogniaApiCall, cogniaHostEnabled, cogniaSessionIdFor } = await import('./lib/cognia.mjs')
    const resolved = cfg || getConfig()
    if (!resolved.progressPush || !cogniaHostEnabled(resolved)) return { pushed: false }
    const sessionId = cogniaSessionIdFor(resolved)
    if (!sessionId) return { pushed: false, reason: 'no_session' }
    const segments = [{ type: 'markdown', md: progressMarkdown(steps, title) }]
    await cogniaApiCall('connector_send', ['--session-id', sessionId, '--segments', JSON.stringify(segments)], { cfg: resolved })
    return { pushed: true }
  } catch (error) {
    return { pushed: false, reason: String(error?.message || error).slice(0, 200) }
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const spec = process.argv[2] || ''
  const title = process.argv[3]
  const steps = spec.trim().startsWith('[') ? JSON.parse(spec) : spec.split(',').map((x) => x.trim()).filter(Boolean)
  console.log(progressMarker(steps, title))
  pushProgress(steps, title).catch(() => {})
}
