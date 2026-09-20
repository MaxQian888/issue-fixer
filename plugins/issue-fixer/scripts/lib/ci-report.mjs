// Generic CI report pipeline: window → dedupe → classify → cluster → render.
// Pure functions, platform-agnostic — collectors (gh, other forges) produce the
// normalized run shape this module consumes. No secrets ever leave this file:
// logs are redacted at signature extraction and never persisted raw.
import { createHash } from 'node:crypto'

export const CI_REPORT_SCHEMA = 'issue-fixer/ci-report/v1'
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled'])

// Failure categories: generic CI/test taxonomy. Repo-specific checks extend via
// `classifyFailureLog`'s checkName rules or a repo-owned classifier wrapper.
const CATEGORY_DETAILS = {
  'assertion-equality': {
    phenomenon: '状态或值断言失败',
    causes: [
      ['产品状态或返回值偏离了测试契约', 'medium', '错误签名包含 assertion equality 特征'],
      ['fixture 或测试预期未随契约变化更新', 'low', '断言类失败也可能来自测试数据或预期过期'],
    ],
    next: '在首个有效栈帧处复现断言，并对照实际值、预期值和本次变更。',
  },
  'wait-for-url': {
    phenomenon: '页面跳转等待超时',
    causes: [
      ['预期导航未发生或目标 URL 与测试契约不一致', 'medium', '失败日志包含 waitForURL 或 URL 等待超时'],
      ['前置请求或页面状态阻塞了导航', 'low', '导航超时可能是更早链路异常的次生现象'],
    ],
    next: '检查超时前最后一个用户动作、网络响应和实际 URL。',
  },
  'wait-for-response': {
    phenomenon: '后端响应等待超时',
    causes: [
      ['目标请求未发出或匹配条件失效', 'medium', '失败日志包含响应等待超时'],
      ['依赖服务延迟或不可用', 'low', '只有等待超时证据，尚不能区分产品与环境'],
    ],
    next: '核对请求是否发出、匹配谓词和依赖服务状态。',
  },
  'webserver-startup': {
    phenomenon: '测试 Web 服务启动失败',
    causes: [['服务启动命令、端口或健康检查异常', 'medium', '失败日志包含 webServer 启动或等待特征']],
    next: '单独运行服务启动命令并验证端口与健康检查。',
  },
  'runtime-api-mismatch': {
    phenomenon: '运行时 API 不匹配',
    causes: [['调用方与运行时依赖版本不兼容', 'high', '错误签名包含 is not a function']],
    next: '核对调用符号、运行时版本和锁文件解析结果。',
  },
  typecheck: {
    phenomenon: '类型检查失败',
    causes: [['类型声明与调用代码不一致', 'high', '日志包含类型诊断或 typecheck 特征']],
    next: '运行最小 typecheck，并从首个诊断开始修复。',
  },
  'unit-test-failure': {
    phenomenon: '单元测试失败',
    causes: [['实现行为或测试 fixture 偏离现有契约', 'medium', '日志包含单元测试失败特征']],
    next: '单独运行首个失败用例并检查 arrange、action、assert。',
  },
  'operation-timeout': {
    phenomenon: '操作或测试总超时',
    causes: [['操作未在时限内完成', 'medium', '日志包含明确 timeout 特征']],
    next: '定位超时前最后一个有效事件，再区分性能、依赖或等待条件问题。',
  },
  'locator-visibility': {
    phenomenon: '元素可见性断言失败',
    causes: [['页面状态、选择器或渲染时序与预期不一致', 'medium', '日志包含 locator 可见性断言']],
    next: '检查当时 DOM、可访问名称与前置状态，不用增加固定等待掩盖问题。',
  },
  'locator-enabled': {
    phenomenon: '控件可用性断言失败',
    causes: [['权限、校验或页面状态使控件保持禁用', 'medium', '日志包含 locator enabled 断言']],
    next: '核对控件禁用条件与测试前置状态。',
  },
  'no-expected-tests': {
    phenomenon: '未发现预期测试',
    causes: [['测试选择参数、路径或生成规则不匹配', 'high', '日志明确显示 no tests found']],
    next: '先运行测试发现命令，核对路径、过滤条件和生成产物。',
  },
  'title-policy': {
    phenomenon: '提交/PR 标题规范检查失败',
    causes: [['标题不符合仓库约定', 'high', '检查名称或日志命中标题门禁']],
    next: '按仓库约定修正标题后重新验证门禁。',
  },
  'sigterm-or-exit143': {
    phenomenon: '执行被 SIGTERM 或 exit 143 中止',
    causes: [['执行被平台取消、超时或资源回收', 'medium', '日志包含 SIGTERM 或 exit 143']],
    next: '检查平台取消原因、超时上限和资源事件。',
  },
  'e2e-unclassified': {
    phenomenon: 'E2E 失败但未提取稳定错误特征',
    causes: [],
    next: '补齐失败 step 日志并从首个业务栈帧开始复现。',
  },
  'no-log': {
    phenomenon: '失败执行没有可用日志',
    causes: [],
    next: '补齐日志权限或采集链路后再判断原因。',
  },
  other: {
    phenomenon: '未分类 CI 失败',
    causes: [],
    next: '获取失败 step 的脱敏日志和首个仓库栈帧后再分类。',
  },
}

// ---------------------------------------------------------------------------
// Window: daily/weekly in an explicit IANA timezone (default UTC).

function ymd(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const v = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${v.year}-${v.month}-${v.day}`
}

// Offset like "+08:00"/"-05:00"/"Z" for `date` in `timezone`.
function tzOffset(timezone, date) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(date).find(part => part.type === 'timeZoneName')?.value || 'GMT'
  if (name === 'GMT') return 'Z'
  return name.replace('GMT', '')
}

export function addDays(value, count) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + count)).toISOString().slice(0, 10)
}

function mondayOf(value) {
  const [year, month, day] = value.split('-').map(Number)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return addDays(value, -((weekday + 6) % 7))
}

function explicitRange(period) {
  if (VALID_DATE.test(period || '')) return [period, period]
  const match = String(period || '').match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/)
  return match ? [match[1], match[2]] : null
}

export function resolveReportWindow({ kind, period, since, until, timezone = 'UTC', now } = {}) {
  if (!['daily', 'weekly'].includes(kind)) throw new Error('kind must be daily or weekly')
  if ((since && !until) || (!since && until)) throw new Error('--since and --until must be provided together')
  const ref = now ? new Date(now) : new Date()
  const today = ymd(ref, timezone)
  let start = since
  let end = until
  if (!start) {
    const range = explicitRange(period)
    if (range) [start, end] = range
    else if (kind === 'daily' && (!period || period === 'yesterday')) start = end = addDays(today, -1)
    else if (kind === 'daily' && period === 'today') start = end = today
    else if (kind === 'weekly' && (!period || period === 'last-week')) {
      start = addDays(mondayOf(today), -7)
      end = addDays(mondayOf(today), -1)
    } else if (kind === 'weekly' && period === 'this-week') {
      start = mondayOf(today)
      end = today
    } else throw new Error(`unsupported ${kind} period: ${period}`)
  }
  if (!VALID_DATE.test(start) || !VALID_DATE.test(end)) throw new Error('dates must use YYYY-MM-DD')
  if (start > end) throw new Error('--since must not be after --until')
  // Offset of the window's start in the target tz — accurate for the dates used;
  // DST edges are reported as warnings by collectors, not silently absorbed.
  const offset = tzOffset(timezone, new Date(`${start}T12:00:00Z`))
  return {
    since: start, until: end, timezone,
    start: `${start}T00:00:00${offset === 'Z' ? 'Z' : offset}`,
    endExclusive: `${addDays(end, 1)}T00:00:00${offset === 'Z' ? 'Z' : offset}`,
    boundary: '[since 00:00, until+1d 00:00)',
  }
}

// ---------------------------------------------------------------------------
// Run normalization

export function dedupePipelineRuns(runs) {
  const byId = new Map()
  for (const run of runs) {
    const id = String(run.runId ?? run.id ?? '')
    if (id && !byId.has(id)) byId.set(id, { ...run, runId: id })
  }
  return [...byId.values()].sort((left, right) => left.runId.localeCompare(right.runId, 'en', { numeric: true }))
}

// Repo-relative stack frame. `repoRoots` are path prefixes that count as
// "inside the repository" — configurable per repo; the default covers common
// layouts. Anything under node_modules is never a repo frame.
const DEFAULT_REPO_ROOTS = ['src/', 'app/', 'apps/', 'packages/', 'lib/', 'components/', 'tests/', 'test/', 'e2e/', 'scripts/', 'plugins/', 'crates/', 'web/']

function repositoryFrame(value, repoRoots = DEFAULT_REPO_ROOTS) {
  const normalized = String(value || '').replaceAll('\\', '/')
  if (normalized.includes('/node_modules/')) return null
  const indexes = repoRoots.map(root => normalized.indexOf(root)).filter(index => index >= 0)
  if (!indexes.length) return null
  return normalized.slice(Math.min(...indexes)).replace(/[),;]+$/, '')
}

export function extractFrames(log, repoRoots) {
  const result = []
  const seen = new Set()
  const pattern = /(?:[A-Za-z]:)?[^\s()[\]{}'"<>]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift):\d+(?::\d+)?/g
  for (const match of String(log || '').matchAll(pattern)) {
    const frame = repositoryFrame(match[0], repoRoots)
    if (frame && !seen.has(frame)) {
      seen.add(frame)
      result.push(frame)
    }
    if (result.length === 8) break
  }
  return result
}

// Highest-scoring line, secrets stripped. This is the ONLY text persisted from
// raw logs — everything else stays in memory.
export function signature(log) {
  const lines = String(log || '').split(/\r?\n/).map((item, index) => {
    const text = item
      .replace(/\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/ig, 'Bearer [REDACTED]')
      .replace(/((?:authorization|cookie)\s*[=:]\s*)[^\r\n]+/ig, '$1[REDACTED]')
      .replace(/((?:token|secret|password|credential)[=:]\s*)\S+/ig, '$1[REDACTED]')
      .trim()
    if (!text || /^[✓✔]/.test(text) || /^(?:find|sed|grep|cat|pnpm|npm|yarn)\s/i.test(text)) return { text, score: -1, index }
    let score = 0
    if (/^(?:assertionerror|typeerror|referenceerror|syntaxerror|error|fatal|exception)\b/i.test(text)) score = 100
    else if (/^(?:fail|failed|failure|✖|×|❌)\b/i.test(text)) score = 90
    else if (/\b(?:assertionerror|typeerror|referenceerror|syntaxerror|exception|is not a function)\b/i.test(text)) score = 80
    else if (/^(?:expected|received)\b/i.test(text)) score = 70
    else if (/\b(?:timed out|timeout of \d+ms|tests? failed|failed tests?|ts\d{4})\b/i.test(text)) score = 60
    else if (/\b(?:error|failed|failure)\b/i.test(text)) score = 40
    return { text, score, index }
  })
  const selected = lines.filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.text || ''
  return selected
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|min)\b/ig, '[duration]')
    .slice(0, 240)
}

export function classifyFailureLog(log, checkName = '', repoRoots) {
  const text = String(log || '')
  const lower = text.toLowerCase()
  const name = String(checkName).toLowerCase()
  let category = 'other'
  if (!text.trim()) category = 'no-log'
  else if (name.includes('title') && /gate|check|policy|lint/.test(name)) category = 'title-policy'
  else if (/waitforurl|waiting for url|page\.waitforurl/.test(lower)) category = 'wait-for-url'
  else if (/waitforresponse|waiting for (?:a )?response|response.*timed out/.test(lower)) category = 'wait-for-response'
  else if (/config\.webserver|webserver.*(?:failed|timeout|timed out)|timed out waiting.*server/.test(lower)) category = 'webserver-startup'
  else if (/is not a function/.test(lower)) category = 'runtime-api-mismatch'
  else if (/tobevisible|locator.*visible|expected.*visible/.test(lower)) category = 'locator-visibility'
  else if (/tobeenabled|locator.*enabled|expected.*enabled/.test(lower)) category = 'locator-enabled'
  else if (/expected:|received:|toequal|\.tobe\(/.test(lower)) category = 'assertion-equality'
  else if (/sigterm|exit(?:ed)? (?:with )?(?:code )?143/.test(lower)) category = 'sigterm-or-exit143'
  else if (/no (?:expected |matching )?tests|no tests found/.test(lower)) category = 'no-expected-tests'
  else if (/operation.*timed out|test timeout|timeout of \d+ms exceeded/.test(lower)) category = 'operation-timeout'
  else if (/ts\d{4}|typecheck|type check|cannot find name|cannot find module/.test(lower)) category = 'typecheck'
  else if (/jest|vitest|mocha|pytest|tests? failed|failed tests?/.test(lower)) category = 'unit-test-failure'
  else if (/playwright|cypress|e2e|test\.step/.test(lower) || name.includes('e2e')) category = 'e2e-unclassified'
  return { category, errorSignature: signature(text), frames: extractFrames(text, repoRoots) }
}

// ---------------------------------------------------------------------------
// CODEOWNERS (GitHub-standard format): "pattern @owner @owner2" per line.

export function parseCodeowners(text) {
  const rules = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [pattern, ...owners] = line.split(/\s+/)
    if (pattern && owners.length) rules.push({ pattern, owners: owners.filter(o => o.startsWith('@') || o.includes('@')) })
  }
  return rules
}

function codeownerMatch(pattern, file) {
  const p = pattern.replace(/^\//, '')
  if (p === '*') return true
  if (p.endsWith('/**')) return file.startsWith(p.slice(0, -3))
  if (p.endsWith('/*')) {
    const dir = p.slice(0, -2)
    return file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes('/')
  }
  if (p.endsWith('/')) return file.startsWith(p)
  if (p.includes('*')) {
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
    return new RegExp(`^${escaped}$`).test(file) || new RegExp(`(^|/)${escaped}$`).test(file)
  }
  return file === p || file.endsWith(`/${p}`)
}

export function resolveCodeowners(frame, rules) {
  const file = String(frame || '').replace(/:\d+(?::\d+)?$/, '')
  // Last match wins in CODEOWNERS — iterate in order, keep the latest hit.
  let owners = []
  for (const rule of rules) if (codeownerMatch(rule.pattern, file)) owners = rule.owners
  return owners
}

// ---------------------------------------------------------------------------

function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * quantile
  const lower = Math.floor(position)
  const fraction = position - lower
  return Math.round(sorted[lower] + (sorted[lower + 1] - sorted[lower]) * fraction)
}

export function normalizeCiStatus(value) {
  const status = String(value || '').toLowerCase()
  if (['success', 'succeed', 'succeeded', 'passed', 'completed'].includes(status)) return 'succeeded'
  if (['failure', 'fail', 'failed', 'timed_out', 'timed-out'].includes(status)) return 'failed'
  if (['running', 'pending', 'queued', 'in_progress', 'in-progress', 'waiting', 'requested'].includes(status)) return 'running'
  if (['cancelled', 'canceled', 'skipped', 'neutral'].includes(status)) return 'canceled'
  return 'unknown'
}

function clusterKey(run) {
  const failure = run.failure || {}
  const locator = failure.frames?.[0] || failure.errorSignature || 'no-evidence'
  return [failure.category || 'other', run.pipeline || 'unknown', failure.job || 'unknown', failure.step || 'unknown', locator].join('|')
}

// Candidate roles: the PR author (change follow-up), CODEOWNERS matches
// (code routing), and whoever triggered the run (operator). Not blame —
// three different kinds of "who might pick this up".
function uniqueCandidates(runs) {
  const candidates = []
  const seen = new Set()
  const add = (identity, role, evidence) => {
    if (!identity || seen.has(`${role}:${identity}`)) return
    seen.add(`${role}:${identity}`)
    candidates.push({ identity, role, evidence })
  }
  for (const run of runs) {
    add(run.mr?.author, 'change-follow-up', `PR !${run.mr?.id ?? '?'} author`)
    for (const owner of run.failure?.codeOwners || []) add(owner, 'code-routing', `CODEOWNERS match for ${run.failure?.frames?.[0]}`)
    add(run.triggerer, 'operator', `triggered run ${run.runId}`)
  }
  const order = { 'change-follow-up': 0, 'code-routing': 1, operator: 2 }
  return candidates.sort((left, right) => order[left.role] - order[right.role] || left.identity.localeCompare(right.identity))
}

function titleFor(kind, window, repository) {
  const repo = repository ? `${repository} ` : ''
  return kind === 'daily'
    ? `${repo}CI 日报 · ${window.since}`
    : `${repo}CI 周报 · ${window.since}~${window.until}`
}

export function buildCiReport(input) {
  const runs = dedupePipelineRuns(input.runs || []).map(run => ({ ...run, status: normalizeCiStatus(run.status) }))
  const statusCounts = { total: runs.length, succeeded: 0, failed: 0, running: 0, canceled: 0, unknown: 0 }
  for (const run of runs) statusCounts[run.status] += 1
  const terminal = runs.filter(run => TERMINAL_STATUSES.has(run.status))
  const terminalSuccessRate = terminal.length ? statusCounts.succeeded / terminal.length : null
  const durations = runs.map(run => Number(run.durationMs)).filter(value => Number.isFinite(value) && value >= 0)
  const clusters = new Map()
  for (const run of runs.filter(item => item.status === 'failed')) {
    const key = clusterKey(run)
    if (!clusters.has(key)) clusters.set(key, [])
    clusters.get(key).push(run)
  }
  const failureClusters = [...clusters].map(([key, items]) => {
    const sample = items[0]
    const failure = sample.failure || {}
    const detail = CATEGORY_DETAILS[failure.category] || CATEGORY_DETAILS.other
    const pipelineRuns = runs.filter(run => (run.pipeline || 'unknown') === (sample.pipeline || 'unknown'))
    const pipelineTerminal = pipelineRuns.filter(run => TERMINAL_STATUSES.has(run.status))
    const pipelineDurations = pipelineRuns.map(run => Number(run.durationMs)).filter(Number.isFinite)
    return {
      key,
      category: failure.category || 'other',
      pipeline: sample.pipeline || 'unknown',
      job: failure.job || 'unknown',
      step: failure.step || 'unknown',
      phenomenon: detail.phenomenon,
      evidenceLevel: failure.evidenceLevel || (failure.errorSignature ? 'signature' : 'metadata'),
      executionCount: pipelineRuns.length,
      failureCount: items.length,
      terminalSuccessRate: pipelineTerminal.length
        ? pipelineTerminal.filter(run => run.status === 'succeeded').length / pipelineTerminal.length
        : null,
      durationMs: { p50: percentile(pipelineDurations, 0.5), p95: percentile(pipelineDurations, 0.95) },
      affectedRunCount: new Set(items.map(item => item.runId)).size,
      affectedRunRate: runs.length ? new Set(items.map(item => item.runId)).size / runs.length : 0,
      locations: [...new Set(items.flatMap(item => item.failure?.frames || []))].slice(0, 8),
      errorSignature: failure.errorSignature || '',
      suspectedCauses: detail.causes.slice(0, 3).map(([text, confidence, evidence]) => ({ text, confidence, evidence })),
      ownerCandidates: uniqueCandidates(items),
      recommendedNextStep: detail.next,
    }
  }).sort((left, right) => right.affectedRunCount - left.affectedRunCount || left.key.localeCompare(right.key))

  const pipelines = [...new Set(runs.map(run => run.pipeline || 'unknown'))].sort().map(name => {
    const items = runs.filter(run => (run.pipeline || 'unknown') === name)
    const states = Object.fromEntries(['succeeded', 'failed', 'running', 'canceled', 'unknown'].map(status => [status, items.filter(run => run.status === status).length]))
    const done = states.succeeded + states.failed + states.canceled
    const values = items.map(run => Number(run.durationMs)).filter(Number.isFinite)
    return { name, executions: items.length, ...states, terminalSuccessRate: done ? states.succeeded / done : null, durationMs: { p50: percentile(values, 0.5), p95: percentile(values, 0.95) } }
  })
  return {
    schemaVersion: CI_REPORT_SCHEMA,
    kind: input.kind,
    title: titleFor(input.kind, input.window, input.repository),
    snapshotAt: input.snapshotAt || new Date().toISOString(),
    repository: input.repository,
    window: input.window,
    coverage: { ...input.coverage, warnings: undefined },
    coverageWarnings: input.coverage?.warnings || [],
    statusCounts,
    terminalSuccessRate,
    durationMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95) },
    pipelines,
    failureClusters,
    evidenceGaps: failureClusters.filter(cluster => ['metadata', 'signature'].includes(cluster.evidenceLevel)
      || ['other', 'no-log', 'e2e-unclassified'].includes(cluster.category))
      .map(cluster => ({ clusterKey: cluster.key, evidenceLevel: cluster.evidenceLevel })),
    publication: null,
  }
}

const percent = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`
const duration = value => value == null ? '—' : value >= 60_000 ? `${(value / 60_000).toFixed(1)} min` : `${(value / 1000).toFixed(1)} s`
const roleLabel = { 'change-follow-up': '当前改动跟进候选', 'code-routing': '代码路由候选', operator: '执行操作者' }

export function renderReportMarkdown(report) {
  const lines = [
    `# ${report.title}`, '',
    `统计窗口：${report.window.since} 至 ${report.window.until}（${report.window.timezone}，${report.window.boundary || '[since, until+1d)'}）`, '',
    '## 核心指标', '',
    `- 执行 ${report.statusCounts.total}：成功 ${report.statusCounts.succeeded}，失败 ${report.statusCounts.failed}，运行中 ${report.statusCounts.running}，取消 ${report.statusCounts.canceled}，未知 ${report.statusCounts.unknown}`,
    `- 终态成功率 ${percent(report.terminalSuccessRate)}；耗时 P50 ${duration(report.durationMs.p50)}，P95 ${duration(report.durationMs.p95)}`, '',
    '## 失败簇', '',
  ]
  if (!report.failureClusters.length) lines.push('本窗口无失败执行。')
  report.failureClusters.forEach((cluster, index) => {
    lines.push(`### ${index + 1}. ${cluster.phenomenon}`)
    lines.push(`Workflow / Job / Step：${cluster.pipeline} / ${cluster.job} / ${cluster.step}`)
    lines.push(`影响：${cluster.affectedRunCount} 个 run（${percent(cluster.affectedRunRate)}）；该 workflow 执行 ${cluster.executionCount}、失败 ${cluster.failureCount}、终态成功率 ${percent(cluster.terminalSuccessRate)}、P50 ${duration(cluster.durationMs.p50)}、P95 ${duration(cluster.durationMs.p95)}；证据等级：${cluster.evidenceLevel}`)
    if (cluster.errorSignature) lines.push(`错误签名：${cluster.errorSignature}`)
    if (cluster.locations.length) lines.push(`位置：${cluster.locations.join('、')}`)
    if (cluster.suspectedCauses.length) lines.push(`可能原因：${cluster.suspectedCauses.map(item => `${item.text}（${item.confidence}；${item.evidence}）`).join('；')}`)
    else lines.push('可能原因：证据不足，不推测。')
    if (cluster.ownerCandidates.length) lines.push(`候选协作者：${cluster.ownerCandidates.map(item => `${roleLabel[item.role]} ${item.identity}`).join('；')}`)
    else lines.push('候选协作者：证据不足，不指定。')
    lines.push(`下一步：${cluster.recommendedNextStep}`, '')
  })
  lines.push('## 覆盖范围与限制', '')
  lines.push(`枚举 run ${report.coverage?.runsEnumerated ?? report.statusCounts.total} 个，采集失败日志 ${report.coverage?.logsCollected ?? 0} 个。`)
  if (report.coverageWarnings.length) report.coverageWarnings.forEach(item => lines.push(`- ${item.source || 'coverage'}：${item.message}`))
  else lines.push('- 未记录覆盖缺口。')
  lines.push('', 'PR 作者、CODEOWNERS 和触发人分别表示当前改动跟进、代码路由和执行操作候选，不构成事故责任认定。')
  return `${lines.join('\n')}\n`
}

export function renderReportSummary(report, docUrl) {
  const lines = [
    `## ${report.title}`,
    `执行 ${report.statusCounts.total}｜失败 ${report.statusCounts.failed}｜终态成功率 ${percent(report.terminalSuccessRate)}｜P95 ${duration(report.durationMs.p95)}`,
  ]
  report.failureClusters.slice(0, 3).forEach((cluster, index) => {
    const cause = cluster.suspectedCauses[0]?.text || '证据不足，暂不推测原因'
    const owners = cluster.ownerCandidates.map(item => `${item.identity}（${roleLabel[item.role]}）`).join('、') || '暂无候选'
    lines.push(`${index + 1}. ${cluster.phenomenon}：${cluster.affectedRunCount} run；可能原因：${cause}；${owners}`)
  })
  if (!report.failureClusters.length) lines.push('本窗口无失败执行。')
  if (report.coverageWarnings.length) lines.push(`覆盖缺口 ${report.coverageWarnings.length} 项，完整口径见文档。`)
  if (docUrl) lines.push(`[查看完整报告](${docUrl})`)
  return lines.join('\n')
}

export function reportDigest(report) {
  const stable = { ...report, snapshotAt: undefined, publication: undefined }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}
