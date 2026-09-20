import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  E2E_RESULT_SCHEMA,
  readResult,
  snapshotRepository,
  validateResult,
  writeResult,
} from '../result.mjs'

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

const completedResult = (snapshot, overrides = {}) => ({
  schemaVersion: E2E_RESULT_SCHEMA,
  mode: 'composed',
  status: 'completed',
  runId: 'resume-button',
  repository: snapshot.repository,
  comparisonPoint: snapshot.comparisonPoint,
  branch: snapshot.branch,
  diffHash: snapshot.diffHash,
  changedFiles: snapshot.changedFiles,
  paths: [{
    id: 'resume-task',
    prerequisite: 'task exists',
    entry: '/tasks/1',
    actions: ['click Resume'],
    expected: 'task resumes',
    diagnosticSignal: 'resume request',
  }],
  manualTestPrompt: {
    prerequisite: 'Open task detail',
    steps: ['Click Resume'],
    expected: ['Task resumes'],
    failureEvidence: ['Screenshot and request log'],
  },
  decision: 'update-e2e',
  ledger: [{
    path: 'resume-task',
    evidence: ['resume.spec.ts asserts resumed state'],
    status: 'covered',
    gap: '',
    owner: 'web',
    command: 'pnpm e2e resume.spec.ts',
  }],
  changes: { specs: ['resume.spec.ts'], fixtures: [], config: [] },
  commands: [
    { command: 'pnpm e2e resume.spec.ts', result: 'fail' },
    { command: 'pnpm e2e resume.spec.ts', result: 'pass' },
  ],
  blockers: [],
  consumer: {
    plugin: 'issue-fixer',
    issueId: 'resume-button',
    fingerprint: 'issue-fingerprint',
  },
  ...overrides,
})

test('snapshot includes committed-range, working-tree, and untracked changes in one stable hash', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'fixer-e2e-snapshot-'))
  t.after(() => rm(repo, { recursive: true, force: true }))

  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test User')
  await writeFile(join(repo, 'tracked.txt'), 'baseline\n')
  git(repo, 'add', 'tracked.txt')
  git(repo, 'commit', '-qm', 'baseline')

  await writeFile(join(repo, 'tracked.txt'), 'changed\n')
  await writeFile(join(repo, 'untracked.txt'), 'one\n')
  const first = await snapshotRepository(repo, 'HEAD')

  assert.deepEqual(first.changedFiles, ['tracked.txt', 'untracked.txt'])
  assert.match(first.comparisonPoint, /^[0-9a-f]{40}$/)
  assert.match(first.diffHash, /^[0-9a-f]{64}$/)

  await writeFile(join(repo, 'untracked.txt'), 'two\n')
  const second = await snapshotRepository(repo, 'HEAD')
  assert.notEqual(second.diffHash, first.diffHash)

  await chmod(join(repo, 'untracked.txt'), 0o755)
  const executable = await snapshotRepository(repo, 'HEAD')
  assert.notEqual(executable.diffHash, second.diffHash)
})

test('composed result is atomically persisted and bound to issue and diff fingerprints', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'fixer-e2e-result-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const snapshot = {
    repository: '/repo',
    comparisonPoint: 'a'.repeat(40),
    branch: 'fix/resume',
    diffHash: 'b'.repeat(64),
    changedFiles: ['ResumeButton.tsx'],
  }
  const path = join(runDir, 'e2e-result.json')

  const receipt = await writeResult(path, completedResult(snapshot), {
    mode: 'composed',
    fingerprint: 'issue-fingerprint',
    diffHash: snapshot.diffHash,
  })

  assert.equal(receipt.schemaVersion, E2E_RESULT_SCHEMA)
  assert.match(receipt.sha256, /^[0-9a-f]{64}$/)
  assert.equal(receipt.path, path)
  assert.doesNotMatch(await readFile(path, 'utf8'), /undefined/)

  const restored = await readResult(path, {
    mode: 'composed',
    fingerprint: 'issue-fingerprint',
    diffHash: snapshot.diffHash,
  })
  assert.equal(restored.decision, 'update-e2e')

  await assert.rejects(
    readResult(path, { mode: 'composed', fingerprint: 'different' }),
    /fingerprint mismatch/,
  )
  await assert.rejects(
    readResult(path, { mode: 'composed', diffHash: 'c'.repeat(64) }),
    /diffHash mismatch/,
  )
  await assert.rejects(
    readResult(path, { mode: 'composed', issueId: 'different-issue' }),
    /issueId mismatch/,
  )
})

test('completed and blocked results have distinct validation bars', () => {
  const snapshot = {
    repository: '/repo',
    comparisonPoint: 'a'.repeat(40),
    branch: 'fix/resume',
    diffHash: 'b'.repeat(64),
    changedFiles: ['ResumeButton.tsx'],
  }

  assert.throws(
    () => validateResult(completedResult(snapshot, { commands: [] })),
    /final command must pass/,
  )

  const blocked = completedResult(snapshot, {
    status: 'blocked',
    decision: 'update-e2e',
    ledger: [{
      path: 'resume-task',
      evidence: ['missing credential'],
      status: 'blocked',
      gap: 'cannot start real backend',
      owner: 'web',
      command: 'pnpm e2e resume.spec.ts',
    }],
    commands: [{ command: 'pnpm e2e resume.spec.ts', result: 'blocked' }],
    changes: { specs: [], fixtures: [], config: [] },
    blockers: [{ reason: 'missing credential', resumeWith: 'provide JWT' }],
  })
  assert.equal(validateResult(blocked).status, 'blocked')
})

test('CLI writes and reads the same composed handoff contract', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'fixer-e2e-cli-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const snapshot = {
    repository: join(runDir, 'product-app'),
    comparisonPoint: 'a'.repeat(40),
    branch: 'fix/resume',
    diffHash: 'b'.repeat(64),
    changedFiles: ['ResumeButton.tsx'],
  }
  const modelPath = join(runDir, 'model.json')
  const resultPath = join(runDir, 'artifacts', 'e2e-result.json')
  await writeFile(modelPath, JSON.stringify(completedResult(snapshot)))

  const script = fileURLToPath(new URL('../result.mjs', import.meta.url))
  const write = spawnSync(process.execPath, [script, 'write', modelPath, resultPath,
    '--mode', 'composed', '--fingerprint', 'issue-fingerprint', '--diff-hash', snapshot.diffHash], {
    encoding: 'utf8',
  })
  assert.equal(write.status, 0, write.stderr)
  assert.equal(JSON.parse(write.stdout).path, resultPath)

  const read = spawnSync(process.execPath, [script, 'read', resultPath,
    '--mode', 'composed', '--issue-id', 'resume-button',
    '--fingerprint', 'issue-fingerprint', '--diff-hash', snapshot.diffHash], {
    encoding: 'utf8',
  })
  assert.equal(read.status, 0, read.stderr)
  const receipt = JSON.parse(read.stdout)
  assert.equal(receipt.status, 'completed')
  assert.equal(receipt.resultPath, resultPath)
  assert.equal(receipt.issueId, 'resume-button')
  assert.equal(receipt.fingerprint, 'issue-fingerprint')
  assert.match(receipt.sha256, /^[0-9a-f]{64}$/)

  const wrongIssue = spawnSync(process.execPath, [script, 'read', resultPath,
    '--mode', 'composed', '--issue-id', 'different-issue'], { encoding: 'utf8' })
  assert.notEqual(wrongIssue.status, 0)
  assert.match(wrongIssue.stderr, /issueId mismatch/)
})

test('CLI read preserves blocked resume evidence in standalone and composed modes', async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), 'fixer-e2e-resume-'))
  t.after(() => rm(runDir, { recursive: true, force: true }))
  const snapshot = {
    repository: join(runDir, 'product-app'),
    comparisonPoint: 'a'.repeat(40),
    branch: 'fix/resume',
    diffHash: 'b'.repeat(64),
    changedFiles: ['ResumeButton.tsx'],
  }
  const script = fileURLToPath(new URL('../result.mjs', import.meta.url))

  for (const mode of ['standalone', 'composed']) {
    const modelPath = join(runDir, `${mode}-model.json`)
    const resultPath = join(runDir, `${mode}-result.json`)
    const model = completedResult(snapshot, {
      mode,
      status: 'blocked',
      changes: { specs: [], fixtures: [], config: [] },
      ledger: [{
        path: 'resume-task',
        evidence: ['missing credential'],
        status: 'blocked',
        gap: 'cannot start backend',
        owner: 'web',
        command: 'pnpm e2e resume.spec.ts',
      }],
      commands: [{ command: 'pnpm e2e resume.spec.ts', result: 'blocked' }],
      blockers: [{ reason: 'missing credential', resumeWith: 'provide JWT' }],
      ...(mode === 'standalone' && { consumer: undefined }),
    })
    await writeFile(modelPath, JSON.stringify(model))
    const binding = mode === 'composed'
      ? ['--issue-id', 'resume-button', '--fingerprint', 'issue-fingerprint']
      : []
    const write = spawnSync(process.execPath, [script, 'write', modelPath, resultPath,
      '--mode', mode, ...binding, '--diff-hash', snapshot.diffHash], { encoding: 'utf8' })
    assert.equal(write.status, 0, write.stderr)

    const read = spawnSync(process.execPath, [script, 'read', resultPath,
      '--mode', mode, ...binding, '--diff-hash', snapshot.diffHash], { encoding: 'utf8' })
    assert.equal(read.status, 0, read.stderr)
    const restored = JSON.parse(read.stdout)
    assert.equal(restored.status, 'blocked')
    assert.equal(restored.blockers[0].resumeWith, 'provide JWT')
    assert.equal(restored.manualTestPrompt.steps[0], 'Click Resume')
    assert.equal(restored.resultPath, resultPath)
    assert.match(restored.sha256, /^[0-9a-f]{64}$/)
  }
})

test('result output cannot be written into the product repository', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fixer-e2e-output-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const repository = join(directory, 'product-app')
  const snapshot = {
    repository,
    comparisonPoint: 'a'.repeat(40),
    branch: 'fix/resume',
    diffHash: 'b'.repeat(64),
    changedFiles: ['ResumeButton.tsx'],
  }

  await assert.rejects(
    writeResult(join(repository, 'e2e-result.json'), completedResult(snapshot)),
    /outside the repository/,
  )
})
