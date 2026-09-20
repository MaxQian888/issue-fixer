#!/usr/bin/env node
import { access, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const marketplacePath = join(repository, '.claude-plugin', 'marketplace.json')
const codexMarketplacePath = join(repository, '.agents', 'plugins', 'marketplace.json')

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const exists = async (path) => access(path).then(() => true, () => false)

const listFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  }))
  return nested.flat()
}

const fail = (message) => {
  throw new Error(message)
}

const marketplace = await readJson(marketplacePath)
if (!marketplace.name || !Array.isArray(marketplace.plugins) || !marketplace.plugins.length) {
  fail('marketplace must have a name and plugins')
}
if (!marketplace.owner?.name) fail('marketplace must declare owner.name')
const codexMarketplace = await readJson(codexMarketplacePath)
if (!Array.isArray(codexMarketplace.plugins)) fail('.agents/plugins/marketplace.json must have plugins')
const codexEntries = new Map(codexMarketplace.plugins.map((plugin) => [plugin.name, plugin]))

const MAX_DEFAULT_PROMPTS = 3
const MAX_DEFAULT_PROMPT_LEN = 128
const CODEX_MANIFEST_PATH_FIELDS = ['skills', 'commands', 'hooks', 'mcpServers', 'apps']

const checkCodexManifest = async (entry, pluginRoot, manifest) => {
  const codexManifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json')
  if (!await exists(codexManifestPath)) {
    fail(`${entry.name}: missing .codex-plugin/plugin.json`)
  }
  const codexManifest = await readJson(codexManifestPath)
  if (codexManifest.name !== manifest.name) {
    fail(`${entry.name}: codex manifest name must match .claude-plugin/plugin.json`)
  }
  if (codexManifest.version !== manifest.version) {
    fail(`${entry.name}: codex manifest version must match .claude-plugin/plugin.json`)
  }
  if (!codexManifest.description) fail(`${entry.name}: codex manifest description is required`)

  for (const field of CODEX_MANIFEST_PATH_FIELDS) {
    const value = codexManifest[field]
    if (value == null) continue
    for (const path of Array.isArray(value) ? value : [value]) {
      if (typeof path !== 'string' || !path.startsWith('./')) {
        fail(`${entry.name}: codex manifest ${field} must start with ./`)
      }
      if (!await exists(join(pluginRoot, path))) {
        fail(`${entry.name}: codex manifest ${field} target missing: ${path}`)
      }
    }
  }

  const prompts = codexManifest.interface?.defaultPrompt
  if (prompts != null) {
    const list = Array.isArray(prompts) ? prompts : [prompts]
    if (list.length > MAX_DEFAULT_PROMPTS) {
      fail(`${entry.name}: codex interface.defaultPrompt supports at most ${MAX_DEFAULT_PROMPTS} entries`)
    }
    for (const prompt of list) {
      const normalized = typeof prompt === 'string' ? prompt.split(/\s+/).filter(Boolean).join(' ') : ''
      if (!normalized || [...normalized].length > MAX_DEFAULT_PROMPT_LEN) {
        fail(`${entry.name}: codex interface.defaultPrompt entries must be 1-${MAX_DEFAULT_PROMPT_LEN} chars`)
      }
    }
  }
}

const checkSkillCodexMetadata = async (entry, files) => {
  for (const skillPath of files.filter((path) => path.endsWith('/SKILL.md'))) {
    const yamlPath = join(dirname(skillPath), 'agents', 'openai.yaml')
    const label = `${entry.name}:${basename(dirname(skillPath))}`
    if (!await exists(yamlPath)) fail(`${label}: missing agents/openai.yaml`)
    const yaml = await readFile(yamlPath, 'utf8')
    if (!/^interface:\s*$/m.test(yaml)) fail(`${label}: openai.yaml needs an interface block`)
    for (const key of ['display_name', 'short_description', 'default_prompt']) {
      if (!new RegExp(`^\\s+${key}:\\s*\\S`, 'm').test(yaml)) {
        fail(`${label}: openai.yaml missing interface.${key}`)
      }
    }
  }
}

const checkCodexHooks = async (entry, pluginRoot) => {
  const claudeHooksPath = join(pluginRoot, 'hooks', 'hooks.json')
  const codexHooksPath = join(pluginRoot, 'hooks', 'hooks-codex.json')
  if (!await exists(claudeHooksPath)) return
  if (!await exists(codexHooksPath)) {
    fail(`${entry.name}: hooks/hooks-codex.json must mirror hooks/hooks.json for Codex`)
  }
  const claudeEvents = Object.keys((await readJson(claudeHooksPath)).hooks ?? {}).sort()
  const codexEvents = Object.keys((await readJson(codexHooksPath)).hooks ?? {}).sort()
  // Parity rule: Codex must not declare events Claude lacks, and events Claude
  // declares must be mirrored — EXCEPT the lifecycle events Codex does not
  // support (e.g. SessionEnd), which are legitimately Claude-only.
  const CLAUDE_ONLY_EVENTS = new Set(['SessionEnd', 'Stop', 'PreCompact', 'InstructionsLoaded'])
  const codexOnly = codexEvents.filter((e) => !claudeEvents.includes(e))
  if (codexOnly.length) fail(`${entry.name}: hooks-codex.json has events missing from hooks.json: ${codexOnly}`)
  const unmirrored = claudeEvents.filter((e) => !codexEvents.includes(e) && !CLAUDE_ONLY_EVENTS.has(e))
  if (unmirrored.length) {
    fail(`${entry.name}: hooks-codex.json must mirror hook events ${unmirrored} (or move them to the Claude-only set)`)
  }
  // Every ${CLAUDE_PLUGIN_ROOT}-relative command target must exist on disk —
  // a renamed hook file otherwise fails silently at session time.
  for (const hooksPath of [claudeHooksPath, codexHooksPath]) {
    const groups = Object.values((await readJson(hooksPath)).hooks ?? {})
    for (const group of groups.flat()) {
      for (const hook of group.hooks ?? []) {
        if (hook.type !== 'command' || typeof hook.command !== 'string') continue
        const m = hook.command.match(/\$\{?CLAUDE_PLUGIN_ROOT\}?\s*[/"']\s*([^"'\s]+)/)
        if (!m) continue
        if (!await exists(join(pluginRoot, m[1]))) {
          fail(`${entry.name}: hook command target missing: ${m[1]} (${basename(hooksPath)})`)
        }
      }
    }
  }
}

const checkSkillDirs = async (entry, pluginRoot) => {
  const skillsDir = join(pluginRoot, 'skills')
  if (!await exists(skillsDir)) return
  for (const dir of await readdir(skillsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    if (!await exists(join(skillsDir, dir.name, 'SKILL.md'))) {
      fail(`${entry.name}: skills/${dir.name}/ has no SKILL.md`)
    }
  }
}

const names = new Set()
for (const entry of marketplace.plugins) {
  if (names.has(entry.name)) fail(`duplicate plugin: ${entry.name}`)
  names.add(entry.name)
  if (!entry.source?.startsWith('./plugins/')) fail(`${entry.name}: source must be under ./plugins`)

  const pluginRoot = resolve(repository, entry.source)
  const manifestPath = join(pluginRoot, '.claude-plugin', 'plugin.json')
  const manifest = await readJson(manifestPath)
  if (basename(pluginRoot) !== entry.name || manifest.name !== entry.name) {
    fail(`${entry.name}: folder, marketplace, and manifest names must match`)
  }
  if (manifest.version !== entry.version) fail(`${entry.name}: manifest and marketplace versions must match`)
  if (!manifest.description || !entry.description) fail(`${entry.name}: descriptions are required`)

  const files = await listFiles(pluginRoot)
  if (!files.some((path) => path.endsWith('/SKILL.md'))) fail(`${entry.name}: at least one skill is required`)
  if (!files.some((path) => path.includes('/commands/') && path.endsWith('.md'))) {
    fail(`${entry.name}: at least one command is required`)
  }
  for (const path of files.filter((value) => /\.(md|json|ya?ml|mjs)$/.test(value))) {
    if ((await readFile(path, 'utf8')).includes('[TODO:')) fail(`${entry.name}: TODO placeholder in ${path}`)
  }

  if (manifest.larkExtension && !await exists(resolve(pluginRoot, manifest.larkExtension))) {
    fail(`${entry.name}: missing larkExtension ${manifest.larkExtension}`)
  }
  if (entry.name === 'e2e-check' && !await exists(join(pluginRoot, 'scripts', 'result.mjs'))) {
    fail('e2e-check: missing result handoff script')
  }

  await checkCodexManifest(entry, pluginRoot, manifest)
  await checkSkillCodexMetadata(entry, files)
  await checkCodexHooks(entry, pluginRoot)
  await checkSkillDirs(entry, pluginRoot)

  const codexEntry = codexEntries.get(entry.name)
  if (!codexEntry) fail(`${entry.name}: missing entry in .agents/plugins/marketplace.json`)
  const codexSource = typeof codexEntry.source === 'string' ? codexEntry.source : codexEntry.source?.path
  if (codexSource !== entry.source) {
    fail(`${entry.name}: codex marketplace source.path must be ${entry.source}`)
  }
  for (const field of ['installation', 'authentication']) {
    if (!codexEntry.policy?.[field]) fail(`${entry.name}: codex marketplace policy.${field} is required`)
  }
  if (!codexEntry.category) fail(`${entry.name}: codex marketplace category is required`)
}

for (const name of codexEntries.keys()) {
  if (!names.has(name)) fail(`${name}: codex marketplace entry has no matching .claude-plugin plugin`)
}

process.stdout.write(`validated ${marketplace.plugins.length} plugins: ${[...names].join(', ')}\n`)
