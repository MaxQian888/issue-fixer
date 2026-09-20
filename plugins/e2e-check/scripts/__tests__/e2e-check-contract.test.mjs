import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readPluginFile = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

const readRepoFile = (path) => readFile(new URL(`../../../../${path}`, import.meta.url), 'utf8')

test('plugin exposes an independent E2E command and skill', async () => {
  const manifest = JSON.parse(await readPluginFile('.claude-plugin/plugin.json'))
  const command = await readPluginFile('commands/check-e2e.md')

  assert.equal(manifest.name, 'e2e-check')
  assert.match(command, /驱动 \*\*e2e-check\*\* skill|Drive the \*\*e2e-check\*\* skill/)
  assert.match(command, /手动测试提示|manual test prompt/i)
  assert.match(command, /standalone/)
  assert.match(command, /result\.mjs snapshot/)
  assert.match(command, /SHA-256 回执|SHA-256 receipt/)
})

test('marketplace publishes issue fixer and E2E check as separate plugins', async () => {
  const marketplace = JSON.parse(await readRepoFile('.claude-plugin/marketplace.json'))
  const rootPackage = JSON.parse(await readRepoFile('package.json'))
  const names = marketplace.plugins.map(({ name }) => name)

  assert.deepEqual(names, ['issue-fixer', 'e2e-check'])
  assert.notEqual(marketplace.plugins[0].source, marketplace.plugins[1].source)
  assert.match(rootPackage.description, /两个可组合的通用插件|Two composable generic plugins/)

  for (const entry of marketplace.plugins) {
    const manifest = JSON.parse(await readRepoFile(`${entry.source}/.claude-plugin/plugin.json`))
    assert.equal(manifest.name, entry.name)
    assert.equal(manifest.version, entry.version)
  }
})

test('repository validation checks both plugin packages as one marketplace', async () => {
  const rootPackage = JSON.parse(await readRepoFile('package.json'))
  assert.equal(rootPackage.scripts['validate:plugins'], 'node scripts/validate-plugins.mjs')

  const repository = fileURLToPath(new URL('../../../../', import.meta.url))
  const result = spawnSync(process.execPath, ['scripts/validate-plugins.mjs'], {
    cwd: repository,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /validated 2 plugins/)
})

test('skill derives user paths from the actual diff and audits assertion-level coverage', async () => {
  const skill = await readPluginFile('skills/e2e-check/SKILL.md')

  assert.match(skill, /真实 diff|actual diff/i)
  assert.match(skill, /用户路径|user path/i)
  assert.match(skill, /entry.*action.*observable result.*diagnostic signal/is)
  assert.match(skill, /arrange.*action.*assert/is)
  assert.match(skill, /git ls-files/i)
  assert.match(skill, /covered \| partial \| missing \| skipped \| blocked/i)
  assert.match(
    skill,
    /立即把 `manualTestPrompt` 作为非阻塞的 assistant 更新|Present `manualTestPrompt` immediately as a non-blocking assistant update/i,
  )
  const manualPromptIndex = Math.max(
    skill.indexOf('立即把 `manualTestPrompt`'),
    skill.indexOf('Present `manualTestPrompt`'),
  )
  const ownerIndex = Math.max(
    skill.indexOf('## 3. 选最窄的 E2E 归属'),
    skill.indexOf('## 3. Choose the narrowest E2E owner'),
  )
  assert.ok(manualPromptIndex >= 0 && manualPromptIndex < ownerIndex)
})

test('skill selects the narrowest existing repo E2E capability instead of a fixed table', async () => {
  const skill = await readPluginFile('skills/e2e-check/SKILL.md')

  assert.match(skill, /归属判定是仓库特定的|ownership is repo-specific/i)
  assert.match(skill, /playwright\.config|e2e\/|tests\/e2e/i)
  assert.match(skill, /确认.*可发现|confirm.*discoverable/is)
  assert.match(skill, /最近的活跃 spec|closest active spec/i)
})

test('skill closes missing regressions without weakening coverage', async () => {
  const skill = await readPluginFile('skills/e2e-check/SKILL.md')

  assert.match(skill, /needs-e2e \| update-e2e \| no-new-e2e/i)
  assert.match(skill, /缺失或 partial 的回归|missing.*implement/is)
  assert.match(skill, /role.*(可访问名|accessible name)/is)
  assert.match(skill, /waitForTimeout/)
  assert.match(skill, /永久 skip|permanent skip/i)
  assert.match(skill, /--list/)
  assert.match(skill, /目标 spec|target spec/i)
  assert.match(skill, /预期失败的复现[\s\S]*通过验证|expected failing reproduction followed by the\s+passing verification/i)
  assert.match(skill, /最终目标验证必须是 `pass`|final target verification must\s+be `pass`/i)
  assert.match(skill, /standalone/)
  assert.match(skill, /composed/)
  assert.match(skill, /result\.mjs write/)
  assert.match(skill, /stale|过期/i)
})

test('skill returns a concrete, non-mandatory manual test prompt', async () => {
  const skill = await readPluginFile('skills/e2e-check/SKILL.md')

  assert.match(skill, /manualTestPrompt/)
  assert.match(skill, /prerequisite/i)
  assert.match(skill, /steps/i)
  assert.match(skill, /expected/i)
  assert.match(skill, /不要把手动测试变成新的强制门禁|do not turn manual testing into a new mandatory gate/i)
  assert.match(skill, /commands: \[\{ command: string, result: pass \| fail \| blocked \}\]/)
})
