import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Public-surface guard: this repo ships externally, so internal product names,
// internal URLs, internal env vars, and internal lane/header conventions must
// never re-enter the tree. New integrations belong behind configurable adapters.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

const TEXT_EXT = /\.(md|mjs|json|ya?ml|txt|toml|sh|ts|js)$/
const FORBIDDEN = [
  /\baiden\b/i,
  /\bbyted(ance)?\b/i,
  /\bmeego\b|\bmeegle\b/i,
  /\bsdma\b/i,
  /\bmarkone\b/i,
  /\bbytedcli\b/i,
  /\bppe\b/i,
  /x-tt-env/i,
  /x-use-ppe/i,
  /code\.byted\.org/i,
  /AIDEN_[A-Z_]+/,
  /SDMA_[A-Z_]+/,
  /CLAUDE_PLUGINS_ROOT/, // legacy plural env name — CLAUDE_PLUGIN_ROOT is correct
]

const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && TEXT_EXT.test(f))
  .filter((f) => f !== 'plugins/issue-fixer/scripts/__tests__/public-surface.test.mjs')

test('no internal product names or identifiers leak into the public repo', () => {
  const hits = []
  for (const file of tracked) {
    let text
    try {
      text = readFileSync(join(REPO, file), 'utf8')
    } catch {
      continue
    }
    for (const pattern of FORBIDDEN) {
      const m = text.match(pattern)
      if (m) hits.push(`${file}: ${m[0]} (${pattern})`)
    }
  }
  assert.deepEqual(hits, [], `internal references found:\n${hits.join('\n')}`)
})
