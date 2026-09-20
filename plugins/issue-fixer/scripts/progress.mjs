// Emit a `fixer:progress` marker. The block is included verbatim in assistant text so it rides
// the turn's streaming events to whatever renderer is attached (an agent-server bridge in
// deployed mode; a readable checklist locally).
// The caller must include this block in assistant text; tool stdout alone is not part of the stream.
// Statuses: pending | running | done | blocked | skipped | error.
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

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const spec = process.argv[2] || ''
  const title = process.argv[3]
  const steps = spec.trim().startsWith('[') ? JSON.parse(spec) : spec.split(',').map((x) => x.trim()).filter(Boolean)
  console.log(progressMarker(steps, title))
}
