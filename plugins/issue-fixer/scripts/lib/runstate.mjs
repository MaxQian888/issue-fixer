// Run-state file — the mechanical half of "resume never re-asks".
//
// <runDir>/run-state.json:
//   { runId, mode, fingerprint, classification, tier, tierHistory, outcome,
//     outcomeHistory, fixKind, surface, severity, route, productEntryUrl,
//     baseBranch, isolation, startBranch, baseSha, worktree, branch, manualTest,
//     gates: { gate1: { round } … }, reopenHistory,
//     steps: { <stepId>: { status, updatedAt, reason?, note?, decisionId?,
//     decision?, summary?, waitingFor?, artifacts?, reopened? } } }
//
// Statuses: pending | running | done | blocked | failed | not-applicable.
//
// STEPS is the orchestrator's canonical step list: the single source of truth
// for step ids, their order (resume point), and their display labels (progress
// block). A step is excluded only by the source mode, the terminal outcome, a
// gate answer, or a missing capability — never by tier: a tier only scales how
// deep a step goes.
//
// Gate decisions carry a DERIVED id — gateDecisionId(runId, gate, round) is
// stable for a given run+gate+round, so a re-entered run finds the recorded
// answer instead of asking a second time (the same reason Cognia derives
// bot-approval interrupt ids from sha256([runId, stepName])). Reopening a gate
// bumps its round, so an answer to the previous question (e.g. a late HIL form
// submit) never approves the new one.
//
// CLI (all output is JSON except `progress`):
//   node runstate.mjs init <runDir> --run-id <id> --mode <tracker-record|direct-evidence>
//        [--fingerprint <fp>] [--classification <c>] [--tier <S|M|L|XL> --reason <r>]
//   node runstate.mjs set <runDir> <step> <status> [--note <t>] [--waiting-for <t>] [--artifact k=v ...]
//   node runstate.mjs meta <runDir> [--classification <c>] [--tier <t> --reason <r>]
//        [--outcome <o> --reason <r>] [--fix-kind <k>] [--surface <s>] [--severity <sev1..4>
//        --severity-source <inferred|reported>] [--fingerprint <fp>] [--route <r>]
//        [--product-entry-url <u>] [--base-branch <b>] [--isolation <worktree|in-place>]
//        [--start-branch <b>] [--base-sha <sha>] [--worktree <path>] [--branch <b>]
//        [--manual-test <passed|failed|blocked|deferred|pending> --manual-evidence <t>]
//   node runstate.mjs gate <runDir> <gate1|gate2|gate3> <decision> [--summary <t>] [--request-id <id>]
//   node runstate.mjs gate-id <runDir> <gate1|gate2|gate3>
//   node runstate.mjs reopen <runDir> <step> --reason <why>
//   node runstate.mjs show <runDir>
//   node runstate.mjs resume <runDir>
//   node runstate.mjs list [artifactsDir]
//   node runstate.mjs progress <runDir> [title]
//   node runstate.mjs fingerprint --source <tracker-record|direct-evidence> --desc <text>
//        [--record-id <id>] [--module <m>] [--priority <p>] [--evidence <file> ...]
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMainModule } from './is-main.mjs'

export const RUN_STATE_FILE = 'run-state.json'

export const STEP_STATUSES = ['pending', 'running', 'done', 'blocked', 'failed', 'not-applicable']

export const MODES = ['tracker-record', 'direct-evidence']
export const CLASSIFICATIONS = ['ui', 'runtime-error', 'backend', 'data', 'performance', 'config', 'security', 'unknown']
export const TIERS = ['S', 'M', 'L', 'XL']
export const FIX_KINDS = ['root-cause', 'workaround', 'mitigation']
export const SURFACES = ['style-copy', 'logic', 'user-visible-protocol', 'performance']
export const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4']
export const ISOLATIONS = ['worktree', 'in-place']
export const MANUAL_TEST_RESULTS = ['passed', 'failed', 'blocked', 'deferred', 'pending']

// Terminal outcomes (resolutions). `fixed` is the only one that ships a diff.
export const OUTCOMES = [
  'fixed',
  'already-fixed',
  'cannot-reproduce',
  'not-a-bug',
  'duplicate',
  'needs-decision',
  'external',
  'escalated',
  'split',
  'abandoned',
]
// Outcomes that end with an investigation report instead of a code change.
export const NO_CHANGE_OUTCOMES = ['already-fixed', 'cannot-reproduce', 'not-a-bug', 'duplicate', 'needs-decision', 'external', 'escalated', 'split']

export const STEPS = [
  { id: 'intake', label: '取证' },
  { id: 'triage', label: '分诊定档' },
  { id: 'reproduce', label: '复现' },
  { id: 'locate', label: '定位' },
  { id: 'gate1', label: '🚦方案' },
  { id: 'worktree', label: '隔离' },
  { id: 'baseline', label: '基线' },
  { id: 'red', label: '红灯' },
  { id: 'fix', label: '改码' },
  { id: 'verify', label: '验证' },
  { id: 'evidence', label: '证据' },
  { id: 'e2e', label: 'E2E' },
  { id: 'review', label: '复核' },
  { id: 'commit', label: '提交' },
  { id: 'gate2', label: '🚦手测+MR' },
  { id: 'publish', label: '推送+MR' },
  { id: 'ci', label: 'CI' },
  { id: 'report', label: '报告' },
  { id: 'gate3', label: '🚦回写' },
  { id: 'writeback', label: '回写+通知' },
  { id: 'audit', label: '完成审计' },
]
export const STEP_ORDER = STEPS.map((step) => step.id)
export const GATES = ['gate1', 'gate2', 'gate3']

// Steps that exist only to produce and ship a code change.
const CHANGE_STEPS = ['worktree', 'baseline', 'red', 'fix', 'verify', 'evidence', 'e2e', 'review', 'commit', 'gate2', 'publish', 'ci']
const TRACKER_ONLY_STEPS = ['gate3', 'writeback']

/**
 * Every answer a gate accepts, and what it does — applied in the same write as
 * the decision, so no resumed run can walk past a "no".
 *   closes         the gate is answered (status done); otherwise it parks as blocked
 *   reopen         rewind to that step (the gate itself is re-asked in a new round)
 *   notApplicable  steps the answer excludes
 *   outcome        outcome the answer sets
 *   manualTest     manual-test result the answer records (gate ②)
 * `rejected` is accepted by every gate as a generic "blocked" (HIL form cancel).
 */
export const GATE_DECISIONS = {
  gate1: {
    approved: { closes: true },
    'changes-requested': { reopen: 'locate' },
    'need-info': {},
    abandon: { closes: true, outcome: 'abandoned' },
  },
  gate2: {
    approved: { closes: true, manualTest: 'passed' },
    'approved-deferred': { closes: true, manualTest: 'deferred' },
    failed: { reopen: 'fix', manualTest: 'failed' },
    'push-only': {},
    'keep-local': { closes: true, notApplicable: ['publish', 'ci'] },
  },
  gate3: {
    approved: { closes: true },
    'writeback-only': { closes: true },
    'changes-requested': {},
    declined: { closes: true, notApplicable: ['writeback'] },
  },
}

/** Derived decision id for a run+gate+round — stable across re-entry, unique per round. */
export function gateDecisionId(runId, gate, round = 1) {
  const key = round > 1 ? `${runId}|${gate}|r${round}` : `${runId}|${gate}`
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 16)
  return `gate:${hex}`
}

const gateRound = (state, gate) => state?.gates?.[gate]?.round || 1

const statePath = (runDir) => join(runDir, RUN_STATE_FILE)

export function loadRunState(runDir) {
  const file = statePath(runDir)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Atomic write (tmp + rename) — a crashed step never leaves a torn state file. */
export function saveRunState(runDir, state) {
  mkdirSync(runDir, { recursive: true })
  const file = statePath(runDir)
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, file)
  return state
}

const assertOneOf = (value, allowed, what) => {
  if (value != null && !allowed.includes(value)) {
    throw new Error(`invalid ${what} "${value}" — use ${allowed.join(' | ')}`)
  }
}

/**
 * Steps excluded by the source mode or the terminal outcome, and why. Returns
 * { stepId: reason }; steps absent from the map apply (gate answers and missing
 * capabilities add their own exclusions on top, with their own reasons).
 */
export function notApplicableSteps({ mode, outcome } = {}) {
  const na = {}
  if (mode === 'direct-evidence') {
    for (const id of TRACKER_ONLY_STEPS) na[id] = 'mode:direct-evidence'
  }
  if (outcome && outcome !== 'fixed') {
    for (const id of CHANGE_STEPS) na[id] = `outcome:${outcome}`
  }
  // An abandoned run publishes nothing; a tracker record it claimed still gets
  // gate ③ so the claim can be released.
  if (outcome === 'abandoned') na.report = 'outcome:abandoned'
  return na
}

const RULE_REASON = /^(mode|outcome):/

/**
 * Re-derive rule-based applicability in place. Never touches a `done` step. A
 * step excluded by an earlier mode/outcome that applies again goes back to
 * `pending` (e.g. cannot-reproduce → user supplies data → fixed).
 */
function applyApplicability(state) {
  const na = notApplicableSteps({ mode: state.mode, outcome: state.outcome })
  const now = new Date().toISOString()
  state.steps = state.steps || {}
  for (const id of STEP_ORDER) {
    const current = state.steps[id]
    if (current?.status === 'done') continue
    if (na[id]) {
      if (current?.status !== 'not-applicable' || current.reason !== na[id]) {
        state.steps[id] = { ...(current || {}), status: 'not-applicable', reason: na[id], updatedAt: now }
      }
    } else if (current?.status === 'not-applicable' && RULE_REASON.test(current.reason || '')) {
      const { reason, ...rest } = current
      state.steps[id] = { ...rest, status: 'pending', updatedAt: now }
    }
  }
  return state
}

export function initRunState(runDir, init) {
  const existing = loadRunState(runDir)
  if (existing) return existing
  assertOneOf(init.mode, MODES, 'mode')
  assertOneOf(init.classification, CLASSIFICATIONS, 'classification')
  assertOneOf(init.tier, TIERS, 'tier')
  const createdAt = new Date().toISOString()
  const state = {
    runId: init.runId,
    mode: init.mode || 'direct-evidence',
    fingerprint: init.fingerprint || '',
    classification: init.classification || 'unknown',
    tier: init.tier || '',
    tierHistory: init.tier ? [{ from: null, tier: init.tier, reason: init.tierReason || 'initial', at: createdAt }] : [],
    outcome: null,
    fixKind: null,
    isolation: 'worktree',
    baseSha: init.baseSha || '',
    worktree: init.worktree || '',
    branch: init.branch || '',
    gates: {},
    steps: {},
    createdAt,
    ...(init.extra || {}),
  }
  return saveRunState(runDir, applyApplicability(state))
}

/** Merge a step patch. Only STEP_STATUSES values are accepted for status. */
export function setStep(runDir, name, patch = {}) {
  const state = loadRunState(runDir) || { runId: '', steps: {} }
  if (patch.status && !STEP_STATUSES.includes(patch.status)) {
    throw new Error(`invalid step status "${patch.status}" — use ${STEP_STATUSES.join(' | ')}`)
  }
  state.steps = state.steps || {}
  const next = { ...(state.steps[name] || {}), ...patch, updatedAt: new Date().toISOString() }
  // A step leaving `blocked` no longer waits on anything.
  if (patch.status && patch.status !== 'blocked' && !('waitingFor' in patch)) delete next.waitingFor
  state.steps[name] = next
  return saveRunState(runDir, state)
}

const gate1Answered = (state) => state.steps?.gate1?.status === 'done'

/**
 * Update run-level facts. Before gate ① is answered, tier and outcome are
 * proposals and may move freely; after it, changing either means the approved
 * plan no longer holds — reopen first (升档/结局变化即回 Gate ①).
 */
export function setMeta(runDir, patch = {}) {
  const state = loadRunState(runDir)
  if (!state) throw new Error(`no run state in ${runDir} — run init first`)
  assertOneOf(patch.classification, CLASSIFICATIONS, 'classification')
  assertOneOf(patch.tier, TIERS, 'tier')
  assertOneOf(patch.outcome, OUTCOMES, 'outcome')
  assertOneOf(patch.fixKind, FIX_KINDS, 'fix kind')
  assertOneOf(patch.surface, SURFACES, 'surface')
  assertOneOf(patch.severity, SEVERITIES, 'severity')
  assertOneOf(patch.severitySource, ['inferred', 'reported'], 'severity source')
  assertOneOf(patch.isolation, ISOLATIONS, 'isolation')
  assertOneOf(patch.manualTest, MANUAL_TEST_RESULTS, 'manual test result')
  const tierChanges = patch.tier != null && patch.tier !== state.tier
  const outcomeChanges = patch.outcome != null && patch.outcome !== state.outcome
  if (gate1Answered(state) && tierChanges) {
    throw new Error('tier changes after Gate ① need `reopen <runDir> gate1 --reason …` first (升档即回 Gate ①)')
  }
  if (gate1Answered(state) && outcomeChanges) {
    throw new Error('outcome changes after Gate ① need `reopen <runDir> locate --reason …` first (结局变化必须重过 Gate ①)')
  }
  const at = new Date().toISOString()
  for (const key of ['classification', 'fixKind', 'surface', 'severity', 'severitySource', 'fingerprint', 'route', 'productEntryUrl', 'baseBranch', 'isolation', 'startBranch', 'baseSha', 'worktree', 'branch']) {
    if (patch[key] != null) state[key] = patch[key]
  }
  if (patch.manualTest != null) {
    state.manualTest = { result: patch.manualTest, evidence: patch.manualEvidence || state.manualTest?.evidence || '', at }
  }
  if (tierChanges) {
    state.tierHistory = [...(state.tierHistory || []), { from: state.tier || null, tier: patch.tier, reason: patch.reason || '', at }]
    state.tier = patch.tier
  }
  if (outcomeChanges) {
    state.outcomeHistory = [...(state.outcomeHistory || []), { from: state.outcome || null, outcome: patch.outcome, reason: patch.reason || '', at }]
    state.outcome = patch.outcome
  }
  return saveRunState(runDir, applyApplicability(state))
}

/**
 * Rewind: `step` and every later step go back to `pending` (rule-based
 * not-applicable steps stay excluded). Artifacts are kept so outward steps
 * re-run by updating what already exists (same branch, same MR, same report
 * document, same record) instead of creating a second one. Every gate that is
 * rewound moves to a new round, so its old answer no longer counts.
 */
function reopenState(state, step, reason) {
  const index = STEP_ORDER.indexOf(step)
  if (index < 0) throw new Error(`unknown step "${step}" — use ${STEP_ORDER.join(' | ')}`)
  if (!reason) throw new Error('reopen needs a reason (the evidence that invalidated the later steps)')
  const at = new Date().toISOString()
  const na = notApplicableSteps({ mode: state.mode, outcome: state.outcome })
  state.gates = state.gates || {}
  for (const id of STEP_ORDER.slice(index)) {
    const current = state.steps?.[id]
    // rule-based exclusions and missing capabilities (manual:) survive a rewind;
    // gate-answer exclusions do not — the gate is asked again
    if (!current || na[id] || /^manual:/.test(current.reason || '')) continue
    const { status, decision, decisionId, summary, waitingFor, note, reason: oldReason, reopened, ...rest } = current
    if (GATES.includes(id) && (decisionId || status === 'done' || status === 'blocked')) {
      state.gates[id] = { round: gateRound(state, id) + 1 }
    }
    state.steps[id] = {
      ...rest,
      status: 'pending',
      reopened: { from: step, reason, previousStatus: status, ...(decision ? { previousDecision: decision } : {}), at },
      updatedAt: at,
    }
  }
  state.reopenHistory = [...(state.reopenHistory || []), { step, reason, at }]
  return applyApplicability(state)
}

export function reopen(runDir, step, reason) {
  const state = loadRunState(runDir)
  if (!state) throw new Error(`no run state in ${runDir}`)
  return saveRunState(runDir, reopenState(state, step, reason))
}

export function stepStatus(state, name) {
  return state?.steps?.[name]?.status || 'pending'
}

/**
 * The resume point: the first step in `order` that is neither done nor
 * not-applicable. `order` defaults to the canonical STEP_ORDER.
 */
export function firstUnfinished(state, order = STEP_ORDER) {
  return order.find((name) => !['done', 'not-applicable'].includes(stepStatus(state, name))) || null
}

/** Resume point plus what it is waiting for — the exact recovery action. */
export function resumePoint(state) {
  const step = firstUnfinished(state)
  if (!step) return { step: null, status: 'complete' }
  const entry = state?.steps?.[step] || {}
  return {
    step,
    label: STEPS.find((s) => s.id === step)?.label || step,
    status: entry.status || 'pending',
    ...(entry.waitingFor ? { waitingFor: entry.waitingFor } : {}),
    ...(entry.note ? { note: entry.note } : {}),
    ...(entry.reopened ? { reopenedBecause: entry.reopened.reason } : {}),
  }
}

/**
 * Record a gate answer under the current round's derived id and apply its
 * effects in the same write. Re-entry resolves the same id and finds this
 * decision — the question is never asked twice in one round.
 *
 * `requestId` (a HIL form's id) must be the current round's id, so an answer
 * to a question that has since been reopened is refused. `strict` (the CLI
 * default) also refuses a gate that does not apply, a gate answered out of
 * order, and a gate ① approval before the tier and outcome are on record.
 */
export function recordGateDecision(runDir, runId, gate, decision, { step, summary, requestId, strict = false } = {}) {
  const state = loadRunState(runDir) || { runId, steps: {} }
  const options = GATE_DECISIONS[gate]
  const known = options && Object.hasOwn(options, decision)
  const spec = known ? options[decision] : (decision === 'rejected' || !options ? {} : null)
  if (!spec) {
    throw new Error(`invalid ${gate} decision "${decision}" — use ${Object.keys(options).join(' | ')} (or rejected)`)
  }
  const currentId = gateDecisionId(runId, gate, gateRound(state, gate))
  if (requestId && requestId !== currentId) {
    throw new Error(`stale answer: ${requestId} is not the current ${gate} round (${currentId}) — the question was reopened; ask again`)
  }
  if (strict) {
    const own = state.steps?.[step || gate]
    if (own?.status === 'not-applicable') throw new Error(`${gate} does not apply to this run (${own.reason || own.note})`)
    const resume = firstUnfinished(state)
    if (resume !== (step || gate)) throw new Error(`${gate} is out of order — the run resumes at ${resume}; finish it first`)
    if (gate === 'gate1' && decision === 'approved' && (!state.tier || !state.outcome)) {
      throw new Error('gate1 approval needs the proposed tier and outcome on record — `meta --tier … --outcome … --reason …` first')
    }
  }
  const name = step || `gate:${gate}`
  const at = new Date().toISOString()
  const decisionId = currentId
  state.steps = state.steps || {}
  const { summary: _s, waitingFor: _w, ...previous } = state.steps[name] || {}
  const entry = { ...previous, decisionId, decision, status: spec.closes ? 'done' : 'blocked', updatedAt: at }
  if (summary) entry.summary = summary
  if (!spec.closes) entry.waitingFor = summary || `${gate}: ${decision}`
  state.steps[name] = entry

  if (spec.manualTest) {
    state.manualTest = { result: spec.manualTest, evidence: summary || '', at }
  }
  for (const id of spec.notApplicable || []) {
    // keep an existing exclusion's own reason (e.g. a missing capability)
    if (['done', 'not-applicable'].includes(state.steps[id]?.status)) continue
    state.steps[id] = { ...(state.steps[id] || {}), status: 'not-applicable', reason: `${gate}:${decision}`, ...(summary ? { note: summary } : {}), updatedAt: at }
  }
  if (spec.outcome && spec.outcome !== state.outcome) {
    state.outcomeHistory = [...(state.outcomeHistory || []), { from: state.outcome || null, outcome: spec.outcome, reason: `${gate}:${decision}`, at }]
    state.outcome = spec.outcome
    applyApplicability(state)
  }
  if (spec.reopen) {
    reopenState(state, spec.reopen, summary || `${gate}: ${decision}`)
    // keep the answer that caused the rewind visible on the (now re-pending) gate
    state.steps[name].reopened.previousDecision = decision
  }
  return saveRunState(runDir, state)
}

/** Look up the current round's recorded gate decision. Null = not answered this round. */
export function gateDecisionFor(state, runId, gate) {
  const id = gateDecisionId(runId, gate, gateRound(state, gate))
  for (const [name, step] of Object.entries(state?.steps || {})) {
    if (step.decisionId === id) return { step: name, decision: step.decision }
  }
  return null
}

// Run-state statuses → the progress block vocabulary (pending|running|done|
// blocked|skipped|error) the deployed bridge renders.
const PROGRESS_STATUS = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  blocked: 'blocked',
  failed: 'error',
  'not-applicable': 'skipped',
}

/** Progress steps derived from run-state, in canonical order. */
export function progressSteps(state) {
  return STEPS.map(({ id, label }) => {
    const entry = state?.steps?.[id] || {}
    const note = entry.status === 'blocked'
      ? entry.waitingFor
      : entry.note || (entry.status === 'not-applicable' ? entry.reason : entry.reopened?.reason)
    return { label, status: PROGRESS_STATUS[entry.status || 'pending'], ...(note ? { note } : {}) }
  })
}

const normalizeText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

/**
 * Deterministic issue fingerprint. Line numbers and row positions are never
 * part of it — they select a record, they do not describe the problem.
 * Evidence files are bound by content hash, so a swapped screenshot changes the
 * fingerprint while a renamed one does not.
 */
export function issueFingerprint({ source, recordId, description, module, priority, evidence = [] } = {}) {
  if (!source) throw new Error(`fingerprint needs --source ${MODES.join(' | ')}`)
  assertOneOf(source, MODES, 'source')
  if (!normalizeText(description)) throw new Error('fingerprint needs the verbatim issue description')
  if (source === 'tracker-record' && !recordId) throw new Error('tracker-record fingerprints need the resolved record id')
  const evidenceHashes = evidence.map((file) => {
    if (!existsSync(file)) return `missing:${file}`
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  }).sort()
  const canonical = JSON.stringify({
    source,
    recordId: source === 'tracker-record' ? recordId : 'not-applicable',
    description: normalizeText(description),
    module: normalizeText(module) || '',
    priority: normalizeText(priority) || '',
    evidence: evidenceHashes,
  })
  const fingerprint = `fp:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`
  return { fingerprint, canonical: JSON.parse(canonical) }
}

const lastUpdated = (state) => Object.values(state.steps || {})
  .map((step) => step.updatedAt || '')
  .reduce((latest, at) => (at > latest ? at : latest), state.createdAt || '')

/** Every run under an artifacts dir — how a run is found again after context loss. */
export function listRuns(artifactsDir) {
  if (!artifactsDir || !existsSync(artifactsDir)) return []
  return readdirSync(artifactsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(artifactsDir, entry.name))
    .map((runDir) => ({ runDir, state: loadRunState(runDir) }))
    .filter(({ state }) => state)
    .map(({ runDir, state }) => ({
      runDir,
      runId: state.runId,
      mode: state.mode,
      fingerprint: state.fingerprint,
      tier: state.tier,
      outcome: state.outcome,
      resume: resumePoint(state),
      updatedAt: lastUpdated(state),
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

// Every flag takes a value; `--evidence`/`--artifact` may repeat. A flag with no
// value is an error rather than a silent `true`, and a value may itself start
// with `--` (e.g. a note quoting a command).
const REPEATABLE = new Set(['artifact', 'evidence'])
const parseFlags = (argv) => {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`)
    const value = argv[++i]
    if (REPEATABLE.has(key)) (flags[key] = flags[key] || []).push(value)
    else flags[key] = value
  }
  return { flags, positional }
}

const META_KEYS = ['runId', 'mode', 'fingerprint', 'classification', 'tier', 'outcome', 'fixKind', 'surface', 'severity', 'severitySource', 'route', 'productEntryUrl', 'baseBranch', 'isolation', 'startBranch', 'baseSha', 'worktree', 'branch', 'manualTest', 'gates']

const describe = (state) => ({
  ...Object.fromEntries(META_KEYS.filter((key) => state[key] != null && state[key] !== '').map((key) => [key, state[key]])),
  resume: resumePoint(state),
  steps: STEP_ORDER.map((id) => ({ id, ...(state.steps?.[id] || { status: 'pending' }) })),
})

if (isMainModule(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  const out = (value) => console.log(JSON.stringify(value, null, 2))
  const need = (runDir) => {
    const state = loadRunState(runDir)
    if (!state) throw new Error(`no run state in ${runDir}`)
    return state
  }
  const run = async () => {
    const { flags, positional } = parseFlags(rest)
    const runDir = positional[0]
    const ARITY = { init: 1, set: 3, meta: 1, gate: 3, 'gate-id': 2, reopen: 2, show: 1, resume: 1, list: 1, progress: 2, fingerprint: 0 }
    if (cmd in ARITY && positional.length > ARITY[cmd]) {
      throw new Error(`${cmd}: unexpected argument(s) ${positional.slice(ARITY[cmd]).join(' ')} — quote values that contain spaces`)
    }
    switch (cmd) {
      case 'init': {
        if (!runDir || !flags.runId || !flags.mode) throw new Error('usage: init <runDir> --run-id <id> --mode <mode>')
        const existing = loadRunState(runDir)
        if (existing && (existing.runId !== flags.runId || existing.mode !== flags.mode
          || (flags.fingerprint && existing.fingerprint && existing.fingerprint !== flags.fingerprint))) {
          throw new Error(`run state in ${runDir} belongs to runId=${existing.runId} mode=${existing.mode} fingerprint=${existing.fingerprint} — resume it (show) or use another runDir`)
        }
        out(describe(initRunState(runDir, {
          runId: flags.runId,
          mode: flags.mode,
          fingerprint: flags.fingerprint,
          classification: flags.classification,
          tier: flags.tier,
          tierReason: flags.reason,
        })))
        break
      }
      case 'set': {
        const [, step, status] = positional
        if (!runDir || !step || !status) throw new Error('usage: set <runDir> <step> <status>')
        if (!STEP_ORDER.includes(step)) throw new Error(`unknown step "${step}" — use ${STEP_ORDER.join(' | ')}`)
        if (GATES.includes(step)) throw new Error(`${step} is a gate — record answers with \`gate <runDir> ${step} <decision>\``)
        need(runDir)
        const patch = { status }
        if (flags.note) patch.note = flags.note
        if (flags.waitingFor) patch.waitingFor = flags.waitingFor
        if (status === 'blocked' && !patch.waitingFor) throw new Error('a blocked step needs --waiting-for <the unblock action>')
        if (status === 'not-applicable') {
          if (!patch.note) throw new Error('not-applicable needs --note <why> (the gate answer or missing capability)')
          patch.reason = `manual:${patch.note}`
        }
        if (flags.artifact) {
          const prev = loadRunState(runDir)?.steps?.[step]?.artifacts || {}
          const pairs = flags.artifact.map((kv) => {
            const cut = kv.indexOf('=')
            if (cut <= 0) throw new Error(`--artifact expects key=value, got "${kv}"`)
            return [kv.slice(0, cut), kv.slice(cut + 1)]
          })
          patch.artifacts = { ...prev, ...Object.fromEntries(pairs) }
        }
        out(describe(setStep(runDir, step, patch)))
        break
      }
      case 'meta': {
        if (!runDir) throw new Error('usage: meta <runDir> [--tier …] [--outcome …]')
        need(runDir)
        if ((flags.tier || flags.outcome) && !flags.reason) throw new Error('--tier/--outcome changes need --reason')
        out(describe(setMeta(runDir, {
          classification: flags.classification,
          tier: flags.tier,
          outcome: flags.outcome,
          fixKind: flags.fixKind,
          surface: flags.surface,
          severity: flags.severity,
          severitySource: flags.severitySource,
          fingerprint: flags.fingerprint,
          route: flags.route,
          productEntryUrl: flags.productEntryUrl,
          baseBranch: flags.baseBranch,
          isolation: flags.isolation,
          startBranch: flags.startBranch,
          baseSha: flags.baseSha,
          worktree: flags.worktree,
          branch: flags.branch,
          manualTest: flags.manualTest,
          manualEvidence: flags.manualEvidence,
          reason: flags.reason,
        })))
        break
      }
      case 'gate': {
        const [, gate, decision] = positional
        if (!runDir || !GATES.includes(gate) || !decision) {
          throw new Error('usage: gate <runDir> <gate1|gate2|gate3> <decision> [--summary <text>]')
        }
        const state = need(runDir)
        out(describe(recordGateDecision(runDir, state.runId, gate, decision, {
          step: gate,
          summary: flags.summary,
          requestId: flags.requestId,
          strict: true,
        })))
        break
      }
      case 'gate-id': {
        const [, gate] = positional
        if (!runDir || !GATES.includes(gate)) throw new Error('usage: gate-id <runDir> <gate1|gate2|gate3>')
        const state = need(runDir)
        const round = gateRound(state, gate)
        out({ gate, round, requestId: gateDecisionId(state.runId, gate, round), options: Object.keys(GATE_DECISIONS[gate]) })
        break
      }
      case 'reopen': {
        const [, step] = positional
        if (!runDir || !step) throw new Error('usage: reopen <runDir> <step> --reason <why>')
        need(runDir)
        out(describe(reopen(runDir, step, flags.reason)))
        break
      }
      case 'show':
        out(describe(need(runDir)))
        break
      case 'resume':
        out(resumePoint(need(runDir)))
        break
      case 'list': {
        let dir = runDir
        if (!dir) {
          const { getConfig } = await import('./config.mjs')
          dir = getConfig().artifactsDir
        }
        if (!dir) throw new Error('usage: list <artifactsDir> (or configure repoDir/FIXER_ARTIFACTS_DIR)')
        out(listRuns(dir))
        break
      }
      case 'progress': {
        const state = need(runDir)
        const { progressMarker, pushProgress } = await import('../progress.mjs')
        const steps = progressSteps(state)
        const title = positional[1] || `修复 ${state.runId}${state.tier ? ` · ${state.tier}` : ''}`
        console.log(progressMarker(steps, title))
        await pushProgress(steps, title)
        break
      }
      case 'fingerprint': {
        out(issueFingerprint({
          source: flags.source,
          recordId: flags.recordId,
          description: flags.desc,
          module: flags.module,
          priority: flags.priority,
          evidence: flags.evidence || [],
        }))
        break
      }
      default:
        console.error('usage: runstate.mjs init|set|meta|gate|gate-id|reopen|show|resume|list|progress|fingerprint …  (see file header)')
        process.exit(2)
    }
  }
  run().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
