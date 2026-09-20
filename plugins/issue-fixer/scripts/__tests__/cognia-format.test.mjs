import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoRoot = resolve(pluginRoot, '..', '..')
const { dedupeSkills, distEntry, STAGING_EXCLUDES } = await import(
  join(repoRoot, 'scripts', 'build-cognia.mjs')
)

test('cognia manifest exists with canonical shape', () => {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'))
  assert.equal(manifest.id, 'issue-fixer')
  assert.equal(manifest.type, 'frontend')
  assert.ok(Array.isArray(manifest.capabilities) && manifest.capabilities.length)
  assert.equal(manifest.author?.name, 'Max Qian')
  assert.ok(manifest.engines?.cognia)
  assert.equal(manifest.main, 'dist/index.js')
  assert.ok(existsSync(join(pluginRoot, manifest.main)))
})

test('every skill id is unique and every bundle source resolves', () => {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'))
  const ids = manifest.skills.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const skill of manifest.skills) {
    if (skill.source.kind === 'inline') continue
    const dir = join(pluginRoot, skill.source.path)
    assert.ok(existsSync(join(dir, 'SKILL.md')), `${skill.id} → ${skill.source.path}`)
  }
})

test('every skills/ dir and commands/ file is represented', () => {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'))
  const ids = new Set(manifest.skills.map((s) => s.id))
  for (const dir of readdirSync(join(pluginRoot, 'skills'), { withFileTypes: true })) {
    if (dir.isDirectory()) assert.ok(ids.has(dir.name), `skills/${dir.name} missing`)
  }
  for (const file of readdirSync(join(pluginRoot, 'commands'))) {
    if (!file.endsWith('.md')) continue
    assert.ok(ids.has(file.replace(/\.md$/, '')), `commands/${file} missing`)
  }
})

test('commandHooks mirror hooks.json and targets exist', () => {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'))
  const hooks = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')).hooks
  for (const [event, groups] of Object.entries(manifest.commandHooks ?? {})) {
    assert.ok(event in hooks, `${event} not in hooks.json`)
    for (const hook of groups.flatMap((g) => g.hooks ?? [])) {
      const m = hook.command.match(/\$\{?COGNIA_PLUGIN_ROOT\}?\s*[/"']\s*([^"'\s]+)/)
      assert.ok(m, `hook command lacks plugin-root token: ${hook.command}`)
      assert.ok(existsSync(join(pluginRoot, m[1])), `missing ${m[1]}`)
    }
  }
})

test('runtime entry manifest parity + activate/deactivate exports', () => {
  const packaged = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'))
  // The entry is CJS while the repo is type:module — load it through a vm
  // sandbox so the evaluation matches the host's loader, not Node's resolution.
  const sandbox = { module: { exports: {} } }
  runInNewContext(readFileSync(join(pluginRoot, 'dist', 'index.js'), 'utf8'), sandbox)
  const definition = sandbox.module.exports.default
  assert.equal(typeof definition.activate, 'function')
  assert.equal(typeof definition.deactivate, 'function')
  // Cross-realm objects can't deepStrictEqual — compare canonical JSON.
  const sort = (v) => Array.isArray(v) ? v.map(sort)
    : (v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
      : v)
  assert.equal(JSON.stringify(sort(definition.manifest)), JSON.stringify(sort(packaged)))
})

test('dedupeSkills drops inline shims that shadow bundle skills', () => {
  const skills = [
    { id: 'branch-sync', source: { kind: 'local-bundle', path: 'skills/branch-sync' } },
    { id: 'branch-sync', source: { kind: 'inline', markdown: 'wrapper' } },
    { id: 'fix-issue', source: { kind: 'inline', markdown: 'entry' } },
  ]
  assert.deepEqual(dedupeSkills(skills).map((s) => s.id), ['branch-sync', 'fix-issue'])
  assert.equal(dedupeSkills(skills)[0].source.kind, 'local-bundle')
})

test('distEntry embeds the manifest and a disposable definition', () => {
  const entry = distEntry({ id: 'x', skills: [] })
  assert.ok(entry.includes('const manifest = {'))
  assert.ok(entry.includes('activate: async'))
  assert.ok(entry.includes('deactivate: async'))
  assert.ok(entry.includes('module.exports'))
})

test('staging excludes the markers that would confuse ecosystem detection', () => {
  assert.ok(STAGING_EXCLUDES.has('.codex-plugin'))
  assert.ok(STAGING_EXCLUDES.has('plugin.json'))
  assert.ok(STAGING_EXCLUDES.has('dist'))
})
