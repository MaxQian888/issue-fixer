// ci-report.mjs — GitHub-first CI daily/weekly report.
//
// Collects Actions runs in a tz-bounded window via `gh`, pulls failed-step logs
// (memory only — raw logs are never persisted), classifies failures into
// clusters, and renders a Chinese markdown report. Publishing goes through the
// configured report adapter (report.mjs publishReport); chat summary goes
// through the configured notify adapter. Non-GitHub forges plug in by
// producing the same normalized run shape.
//
// Usage:
//   node ci-report.mjs --kind daily [--period yesterday|today|YYYY-MM-DD[..YYYY-MM-DD]]
//     [--since YYYY-MM-DD --until YYYY-MM-DD] [--tz <IANA>] [--repo owner/name]
//     [--ref <branch> [--ref <branch2>]] [--owners <CODEOWNERS path>]
//     [--out <dir>] [--publish] [--chat-id <id>] [--dry-run] [--limit N]
//     [--max-failed N]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig } from './lib/config.mjs'
import { parseGithubRepo } from './lib/forge.mjs'
import {
  buildCiReport,
  classifyFailureLog,
  parseCodeowners,
  renderReportMarkdown,
  renderReportSummary,
  reportDigest,
  resolveCodeowners,
  resolveReportWindow,
} from './lib/ci-report.mjs'
import { publishReport } from './report.mjs'
import { sendCard } from './lib/notify.mjs'

const RUN_LIST_FIELDS = 'attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,name,number,startedAt,status,updatedAt,url,workflowName'
const CODEOWNERS_CANDIDATES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']

const gh = (args, { cwd, maxBuffer = 32 * 1024 * 1024 } = {}) =>
  execFileSync('gh', args, { cwd, encoding: 'utf8', maxBuffer })

const ghJson = (args, opts) => JSON.parse(gh(args, opts))

function resolveRepo(cfg, explicit) {
  if (explicit) return explicit
  if (cfg.forge.repo) return cfg.forge.repo
  try {
    return parseGithubRepo(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: cfg.repoDir, encoding: 'utf8' }))
  } catch {
    return null // let gh resolve from cwd
  }
}

function listRuns(repo, window, refs, { limit, cwd, warnings }) {
  const args = ['run', 'list', '--limit', String(limit), '--json', RUN_LIST_FIELDS]
  if (repo) args.push('-R', repo)
  let all = []
  const targets = refs.length ? refs : [null]
  for (const ref of targets) {
    const scoped = ref ? [...args, '--branch', ref] : args
    const batch = ghJson(scoped, { cwd })
    if (batch.length >= limit) {
      warnings.push({ source: 'run-list', message: `--limit ${limit} 可能被截断（ref=${ref || 'all'}），请缩小窗口或增大 --limit` })
    }
    all = all.concat(batch)
  }
  return all
}

// Window filter lives here (not inside listRuns) so injected collectors get it too.
function inWindow(item, window) {
  const at = Date.parse(item.startedAt || item.createdAt || item.triggeredAt || '')
  return Number.isFinite(at) && at >= Date.parse(window.start) && at < Date.parse(window.endExclusive)
}

function apiRunDetail(repo, runId, cwd, warnings) {
  if (!repo) {
    warnings.push({ source: 'run-detail', message: `run ${runId}: 无法解析 owner/repo，跳过 actor/PR 关联` })
    return null
  }
  try {
    return ghJson(['api', `repos/${repo}/actions/runs/${runId}`], { cwd })
  } catch (error) {
    warnings.push({ source: 'run-detail', message: `run ${runId}: detail 获取失败（${String(error.message).slice(0, 120)}）` })
    return null
  }
}

function apiJobs(repo, runId, cwd, warnings) {
  if (!repo) return null
  try {
    const out = ghJson(['api', `repos/${repo}/actions/runs/${runId}/jobs`, '--paginate'], { cwd })
    return out.jobs || []
  } catch (error) {
    warnings.push({ source: 'jobs', message: `run ${runId}: jobs 获取失败（${String(error.message).slice(0, 120)}）` })
    return null
  }
}

function apiPrAuthor(repo, prNumber, cwd) {
  try {
    return ghJson(['api', `repos/${repo}/pulls/${prNumber}`], { cwd })?.user?.login || null
  } catch {
    return null
  }
}

function failedLog(repo, runId, cwd) {
  const args = ['run', 'view', String(runId), '--log-failed']
  if (repo) args.push('-R', repo)
  try {
    return gh(args, { cwd })
  } catch {
    return ''
  }
}

function pickFailedStep(job) {
  const step = (job?.steps || []).find(s => String(s.conclusion).toLowerCase() === 'failure')
  return step?.name || null
}

function loadOwnerRules(repoDir, explicit, warnings) {
  const candidates = explicit ? [explicit] : CODEOWNERS_CANDIDATES.map(p => join(repoDir, p))
  for (const path of candidates) {
    if (existsSync(path)) {
      try { return parseCodeowners(readFileSync(path, 'utf8')) } catch { /* fall through */ }
    }
  }
  if (explicit) warnings.push({ source: 'owners', message: `CODEOWNERS 不可读：${explicit}` })
  return []
}

export async function collectGithubRuns({ repo, window, refs = [], repoDir, limit = 500, maxFailed = 50, ownersPath, ghImpl } = {}) {
  const warnings = []
  const call = ghImpl || { listRuns, detail: apiRunDetail, jobs: apiJobs, prAuthor: apiPrAuthor, failedLog }
  const cwd = repoDir
  const enumerated = call.listRuns(repo, window, refs, { limit, cwd, warnings })
  const raw = enumerated.filter(item => inWindow(item, window))
  const ownerRules = loadOwnerRules(repoDir, ownersPath, warnings)
  let failedSeen = 0
  const runs = raw.map(item => {
    const status = item.conclusion || item.status
    const durationMs = Date.parse(item.updatedAt || '') - Date.parse(item.startedAt || item.createdAt || '')
    const run = {
      runId: String(item.databaseId),
      pipeline: item.workflowName || item.name || 'unknown',
      status,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
      branch: item.headBranch || '',
      url: item.url || '',
      triggerer: null,
      mr: null,
      failure: null,
    }
    const normalized = String(status).toLowerCase()
    if (!['failure', 'failed', 'timed_out'].includes(normalized)) return run
    if (failedSeen >= maxFailed) {
      failedSeen += 1
      return run
    }
    failedSeen += 1
    const detail = call.detail(repo, run.runId, cwd, warnings)
    if (detail) {
      run.triggerer = detail.actor?.login || null
      const pr = (detail.pull_requests || [])[0]
      if (pr?.number) run.mr = { id: pr.number, author: call.prAuthor(repo, pr.number, cwd) }
    }
    const jobs = call.jobs(repo, run.runId, cwd, warnings)
    const job = (jobs || []).find(j => String(j.conclusion).toLowerCase() === 'failure')
    const step = pickFailedStep(job)
    const log = call.failedLog(repo, run.runId, cwd) // memory only — never persisted
    const classified = classifyFailureLog(log, job?.name || run.pipeline)
    run.failure = {
      job: job?.name || 'unknown',
      step: step || 'unknown',
      evidenceLevel: log.trim() ? 'signature' : 'metadata',
      ...classified,
      codeOwners: classified.frames.length ? [...new Set(classified.frames.flatMap(f => resolveCodeowners(f, ownerRules)))] : [],
    }
    return run
  })
  if (failedSeen > maxFailed) {
    warnings.push({ source: 'failed-detail', message: `失败 run ${failedSeen} 个，超出 --max-failed ${maxFailed}，${failedSeen - maxFailed} 个未采集失败日志` })
  }
  return { runs, warnings, enumerated: enumerated.length }
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { refs: [], limit: 500, maxFailed: 50 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--kind': args.kind = next(); break
      case '--period': args.period = next(); break
      case '--since': args.since = next(); break
      case '--until': args.until = next(); break
      case '--tz': case '--timezone': args.timezone = next(); break
      case '--repo': args.repo = next(); break
      case '--ref': case '--branch': args.refs.push(next()); break
      case '--owners': args.ownersPath = next(); break
      case '--out': args.out = next(); break
      case '--publish': args.publish = true; break
      case '--chat-id': args.chatId = next(); break
      case '--dry-run': args.dryRun = true; break
      case '--limit': args.limit = Number(next()); break
      case '--max-failed': args.maxFailed = Number(next()); break
      default: throw new Error(`unknown flag: ${a}`)
    }
  }
  return args
}

async function pushSummary(report, args, cfg) {
  const summary = renderReportSummary(report, report.publication?.url)
  if (cfg.notify.type === 'lark' || args.chatId) {
    const chatId = args.chatId || cfg.notify.chatId
    if (!chatId) throw new Error('--chat-id 或 notify.chatId 均未配置，无法推送摘要')
    await sendCard({ chatId }, {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: report.title }, template: report.statusCounts.failed ? 'red' : 'green' },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: summary } }],
    })
    return { pushed: 'lark-cli', chatId }
  }
  return { pushed: null, reason: `notify.type=${cfg.notify.type} 未配置 chat 推送` }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv)
  if (!args.kind) throw new Error('--kind daily|weekly is required')
  const cfg = deps.cfg || getConfig()
  const repo = resolveRepo(cfg, args.repo)
  const timezone = args.timezone || cfg.report?.timezone || 'UTC'
  const window = resolveReportWindow({ kind: args.kind, period: args.period, since: args.since, until: args.until, timezone })

  const { runs, warnings, enumerated } = await collectGithubRuns({
    repo, window, refs: args.refs, repoDir: cfg.repoDir,
    limit: args.limit, maxFailed: args.maxFailed, ownersPath: args.ownersPath,
    ghImpl: deps.ghImpl,
  })

  const report = buildCiReport({
    kind: args.kind,
    window,
    repository: repo,
    runs,
    coverage: { runsEnumerated: enumerated, logsCollected: runs.filter(r => r.failure?.errorSignature).length, warnings },
  })
  const markdown = renderReportMarkdown(report)
  const digest = reportDigest(report)

  if (args.dryRun) {
    return { report, markdown, digest, pushed: null, published: null }
  }

  const outDir = args.out || join(cfg.repoDir, 'ci-reports')
  mkdirSync(outDir, { recursive: true })
  const base = `ci-${args.kind}-${window.since}${window.until !== window.since ? `-${window.until}` : ''}`
  const mdPath = join(outDir, `${base}.md`)
  const jsonPath = join(outDir, `${base}.json`)
  writeFileSync(mdPath, markdown)
  writeFileSync(jsonPath, JSON.stringify({ ...report, digest }, null, 2))

  let published = null
  if (args.publish) {
    published = await publishReport(mdPath, report.title)
    report.publication = published
    writeFileSync(jsonPath, JSON.stringify({ ...report, digest }, null, 2)) // re-record publication
  }

  let pushed = null
  if (args.chatId || (args.publish && cfg.notify.chatId)) {
    pushed = await pushSummary(report, args, cfg)
  }

  return { report, markdown, digest, mdPath, jsonPath, published, pushed }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(result => {
    console.log(JSON.stringify({
      title: result.report.title,
      window: result.report.window,
      statusCounts: result.report.statusCounts,
      failureClusters: result.report.failureClusters.length,
      coverageWarnings: result.report.coverageWarnings,
      mdPath: result.mdPath, jsonPath: result.jsonPath,
      published: result.published, pushed: result.pushed, digest: result.digest,
    }, null, 2))
  }).catch(error => {
    console.error(`ci-report: ${error.message}`)
    process.exit(1)
  })
}
