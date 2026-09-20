// Run-state file — the mechanical half of "resume never re-asks".
//
// <runDir>/run-state.json:
//   { runId, mode, baseSha, worktree, steps: { <name>: { status, updatedAt,
//     decisionId?, decision?, waitingFor?, artifacts? } } }
//
// Statuses: pending | running | done | blocked | failed | not-applicable.
//
// Gate decisions carry a DERIVED id — gateDecisionId(runId, gate) is stable for
// a given run+gate, so a re-entered run finds the recorded answer instead of
// asking a second time (the same reason Cognia derives bot-approval interrupt
// ids from sha256([runId, stepName])). A fresh issue/run id re-asks; a resumed
// one never does.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const RUN_STATE_FILE = 'run-state.json'

export const STEP_STATUSES = ['pending', 'running', 'done', 'blocked', 'failed', 'not-applicable']

/** Derived decision id for a run+gate — stable across re-entry, unique per run. */
export function gateDecisionId(runId, gate) {
  const hex = createHash('sha256').update(`${runId}|${gate}`).digest('hex').slice(0, 16)
  return `gate:${hex}`
}

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

export function initRunState(runDir, init) {
  const existing = loadRunState(runDir)
  if (existing) return existing
  return saveRunState(runDir, {
    runId: init.runId,
    mode: init.mode || 'direct-evidence',
    fingerprint: init.fingerprint || '',
    baseSha: init.baseSha || '',
    worktree: init.worktree || '',
    steps: {},
    createdAt: new Date().toISOString(),
    ...(init.extra || {}),
  })
}

/** Merge a step patch. Only STEP_STATUSES values are accepted for status. */
export function setStep(runDir, name, patch = {}) {
  const state = loadRunState(runDir) || { runId: '', steps: {} }
  if (patch.status && !STEP_STATUSES.includes(patch.status)) {
    throw new Error(`invalid step status "${patch.status}" — use ${STEP_STATUSES.join(' | ')}`)
  }
  state.steps = state.steps || {}
  state.steps[name] = { ...(state.steps[name] || {}), ...patch, updatedAt: new Date().toISOString() }
  return saveRunState(runDir, state)
}

export function stepStatus(state, name) {
  return state?.steps?.[name]?.status || 'pending'
}

/**
 * The resume point: the first step in `order` that is neither done nor
 * not-applicable. `order` is the orchestrator's canonical step list.
 */
export function firstUnfinished(state, order) {
  return order.find((name) => !['done', 'not-applicable'].includes(stepStatus(state, name))) || null
}

/**
 * Record a gate answer under its derived id. Re-entry resolves the same id and
 * finds this decision — the question is never asked twice for one run.
 */
export function recordGateDecision(runDir, runId, gate, decision, { step } = {}) {
  const decisionId = gateDecisionId(runId, gate)
  const patch = { decisionId, decision, status: decision === 'rejected' ? 'blocked' : 'done' }
  return setStep(runDir, step || `gate:${gate}`, patch)
}

/** Look up a recorded gate decision by its derived id. Null = never answered. */
export function gateDecisionFor(state, runId, gate) {
  const id = gateDecisionId(runId, gate)
  for (const [name, step] of Object.entries(state?.steps || {})) {
    if (step.decisionId === id) return { step: name, decision: step.decision }
  }
  return null
}
