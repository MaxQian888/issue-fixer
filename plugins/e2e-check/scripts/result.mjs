#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export const E2E_RESULT_SCHEMA = 'issue-fixer-e2e/v1'

const DECISIONS = new Set(['needs-e2e', 'update-e2e', 'no-new-e2e'])
const LEDGER_STATUSES = new Set(['covered', 'partial', 'missing', 'skipped', 'blocked'])
const COMMAND_RESULTS = new Set(['pass', 'fail', 'blocked'])

const git = (cwd, args, { encoding = 'utf8' } = {}) => {
  const result = spawnSync('git', args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr
    throw new Error(`git ${args.join(' ')} failed: ${(detail || '').trim()}`)
  }
  return result.stdout
}

const splitNull = (value) => value.toString('utf8').split('\0').filter(Boolean)
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0
const requireArray = (value, field) => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value
}

export async function snapshotRepository(repository, comparisonRef) {
  if (!repository) throw new Error('repository is required')
  if (!comparisonRef) throw new Error('comparisonRef is required')

  const requested = await realpath(repository)
  const root = git(requested, ['rev-parse', '--show-toplevel']).trim()
  const resolvedRoot = await realpath(root)
  const comparisonPoint = git(resolvedRoot, ['rev-parse', `${comparisonRef}^{commit}`]).trim()
  const branch = git(resolvedRoot, ['branch', '--show-current']).trim() || 'detached'
  const trackedDiff = git(resolvedRoot, ['diff', '--binary', '--no-ext-diff', comparisonPoint, '--'], {
    encoding: 'buffer',
  })
  const trackedFiles = splitNull(git(resolvedRoot, ['diff', '--name-only', '-z', comparisonPoint, '--']))
  const untrackedFiles = splitNull(git(resolvedRoot, ['ls-files', '--others', '--exclude-standard', '-z']))
    .sort()

  const hash = createHash('sha256')
  hash.update('tracked-diff\0')
  hash.update(trackedDiff)
  for (const path of untrackedFiles) {
    hash.update('\0untracked\0')
    hash.update(path)
    hash.update('\0')
    const absolutePath = resolve(resolvedRoot, path)
    const stat = await lstat(absolutePath)
    hash.update(`type:${stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other'}\0`)
    hash.update(`mode:${(stat.mode & 0o777).toString(8)}\0`)
    hash.update(stat.isSymbolicLink() ? await readlink(absolutePath) : await readFile(absolutePath))
  }

  return {
    repository: resolvedRoot,
    comparisonPoint,
    branch,
    diffHash: hash.digest('hex'),
    changedFiles: [...new Set([...trackedFiles, ...untrackedFiles])].sort(),
  }
}

export function validateResult(result, expected = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('result must be an object')
  if (result.schemaVersion !== E2E_RESULT_SCHEMA) throw new Error(`schemaVersion must be ${E2E_RESULT_SCHEMA}`)
  if (!['standalone', 'composed'].includes(result.mode)) throw new Error('mode must be standalone or composed')
  if (!['completed', 'blocked'].includes(result.status)) throw new Error('status must be completed or blocked')
  if (!nonEmpty(result.runId)) throw new Error('runId is required')
  if (!nonEmpty(result.repository)) throw new Error('repository is required')
  if (!/^[0-9a-f]{40,64}$/.test(result.comparisonPoint || '')) throw new Error('comparisonPoint is invalid')
  if (!nonEmpty(result.branch)) throw new Error('branch is required')
  if (!/^[0-9a-f]{64}$/.test(result.diffHash || '')) throw new Error('diffHash is invalid')
  if (!requireArray(result.changedFiles, 'changedFiles').length) throw new Error('changedFiles must not be empty')
  if (!requireArray(result.paths, 'paths').length) throw new Error('paths must not be empty')

  for (const path of result.paths) {
    if (!nonEmpty(path.id) || !nonEmpty(path.entry) || !nonEmpty(path.expected)
      || !nonEmpty(path.diagnosticSignal) || !requireArray(path.actions, 'path.actions').length) {
      throw new Error('each path requires id, entry, actions, expected, and diagnosticSignal')
    }
  }

  const prompt = result.manualTestPrompt
  if (!prompt || typeof prompt !== 'object') throw new Error('manualTestPrompt is required')
  if (!requireArray(prompt.steps, 'manualTestPrompt.steps').length) {
    throw new Error('manualTestPrompt.steps must not be empty')
  }
  if (!requireArray(prompt.expected, 'manualTestPrompt.expected').length) {
    throw new Error('manualTestPrompt.expected must not be empty')
  }
  requireArray(prompt.failureEvidence, 'manualTestPrompt.failureEvidence')

  if (!DECISIONS.has(result.decision)) throw new Error('decision is invalid')
  if (!requireArray(result.ledger, 'ledger').length) throw new Error('ledger must not be empty')
  for (const row of result.ledger) {
    if (!nonEmpty(row.path) || !LEDGER_STATUSES.has(row.status)
      || !requireArray(row.evidence, 'ledger.evidence').length || !nonEmpty(row.owner)) {
      throw new Error('each ledger row requires path, evidence, valid status, and owner')
    }
  }

  if (!result.changes || typeof result.changes !== 'object') throw new Error('changes is required')
  for (const field of ['specs', 'fixtures', 'config']) requireArray(result.changes[field], `changes.${field}`)
  if (result.status === 'completed'
    && ['needs-e2e', 'update-e2e'].includes(result.decision)
    && !result.changes.specs.length) {
    throw new Error('changes.specs must include the added or updated E2E')
  }

  requireArray(result.commands, 'commands')
  for (const command of result.commands) {
    if (!nonEmpty(command.command) || !COMMAND_RESULTS.has(command.result)) {
      throw new Error('each command requires a command and valid result')
    }
  }
  requireArray(result.blockers, 'blockers')

  if (result.mode === 'composed') {
    if (!result.consumer || result.consumer.plugin !== 'issue-fixer'
      || !nonEmpty(result.consumer.issueId) || !nonEmpty(result.consumer.fingerprint)) {
      throw new Error('composed result requires the issue-fixer consumer binding')
    }
  }
  if (expected.mode && result.mode !== expected.mode) throw new Error(`mode mismatch: expected ${expected.mode}`)
  if (expected.fingerprint && result.consumer?.fingerprint !== expected.fingerprint) {
    throw new Error('fingerprint mismatch')
  }
  if (expected.issueId && result.consumer?.issueId !== expected.issueId) throw new Error('issueId mismatch')
  if (expected.diffHash && result.diffHash !== expected.diffHash) throw new Error('diffHash mismatch')

  const actionable = result.ledger.find(({ status }) => ['partial', 'missing', 'blocked'].includes(status))
  const finalCommand = result.commands.at(-1)
  if (result.status === 'completed') {
    if (actionable) throw new Error(`completed result has an actionable gap: ${actionable.path}`)
    if (result.blockers.length) throw new Error('completed result must not contain blockers')
    if (!finalCommand || finalCommand.result !== 'pass') throw new Error('completed result final command must pass')
  } else {
    if (!result.blockers.length) throw new Error('blocked result requires at least one blocker')
    if (!actionable && finalCommand?.result !== 'blocked') {
      throw new Error('blocked result requires blocked ledger or command evidence')
    }
  }

  return result
}

export async function writeResult(path, result, expected = {}) {
  const normalized = { ...result, generatedAt: result.generatedAt || new Date().toISOString() }
  validateResult(normalized, expected)
  const output = resolve(path)
  const repository = resolve(normalized.repository)
  const outputFromRepository = relative(repository, output)
  if (!outputFromRepository || (!outputFromRepository.startsWith('..') && !isAbsolute(outputFromRepository))) {
    throw new Error('E2E result output must be outside the repository')
  }
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(output), { recursive: true })
  try {
    await writeFile(temporary, serialized, { flag: 'wx' })
    await rename(temporary, output)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return createReceipt(output, serialized, normalized)
}

const createReceipt = (resultPath, serialized, result) => ({
  path: resultPath,
  resultPath,
  schemaVersion: E2E_RESULT_SCHEMA,
  sha256: createHash('sha256').update(serialized).digest('hex'),
  status: result.status,
  decision: result.decision,
  diffHash: result.diffHash,
  ...(result.consumer && {
    issueId: result.consumer.issueId,
    fingerprint: result.consumer.fingerprint,
  }),
})

const loadResult = async (path, expected) => {
  const resultPath = resolve(path)
  let serialized
  let parsed
  try {
    serialized = await readFile(resultPath, 'utf8')
    parsed = JSON.parse(serialized)
  } catch (error) {
    throw new Error(`cannot read E2E result: ${error.message}`)
  }
  validateResult(parsed, expected)
  return { resultPath, serialized, parsed }
}

export async function readResult(path, expected = {}) {
  return (await loadResult(path, expected)).parsed
}

export async function readResultReceipt(path, expected = {}) {
  const { resultPath, serialized, parsed } = await loadResult(path, expected)
  return { ...parsed, ...createReceipt(resultPath, serialized, parsed) }
}

const parseExpected = (args) => {
  const expected = {}
  const nextValue = (index, option) => {
    const value = args[index + 1]
    if (!nonEmpty(value) || value.startsWith('--')) throw new Error(`${option} requires a value`)
    return value
  }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--mode') expected.mode = nextValue(index++, value)
    else if (value === '--issue-id') expected.issueId = nextValue(index++, value)
    else if (value === '--fingerprint') expected.fingerprint = nextValue(index++, value)
    else if (value === '--diff-hash') expected.diffHash = nextValue(index++, value)
    else throw new Error(`unknown argument: ${value}`)
  }
  return expected
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const [command, ...args] = process.argv.slice(2)
  const run = async () => {
    if (command === 'snapshot') {
      process.stdout.write(`${JSON.stringify(await snapshotRepository(args[0], args[1]), null, 2)}\n`)
      return
    }
    if (command === 'write') {
      const model = JSON.parse(await readFile(resolve(args[0]), 'utf8'))
      const receipt = await writeResult(args[1], model, parseExpected(args.slice(2)))
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
      return
    }
    if (command === 'read') {
      const result = await readResultReceipt(args[0], parseExpected(args.slice(1)))
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }
    if (command === 'validate') {
      const result = await readResult(args[0], parseExpected(args.slice(1)))
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }
    throw new Error('usage: result.mjs snapshot <repo> <ref> | write <model> <out> [--mode ... --issue-id ... --fingerprint ... --diff-hash ...] | read|validate <result> [options]')
  }
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
