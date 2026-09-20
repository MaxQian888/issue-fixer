// Central config resolution for issue-fixer. Everything that used to be hard-coded to one
// product repo / one tracker / one forge now resolves through here.
//
// Resolution order (later wins):
//   1) built-in defaults
//   2) fixer.config.json — searched at $FIXER_CONFIG, then <repoDir>/fixer.config.json,
//      then <repoDir>/.fixer/config.json
//   3) FIXER_* environment variables
//
// Env vars:
//   FIXER_CONFIG             absolute path to fixer.config.json
//   FIXER_REPO_DIR           target repo main checkout (tools resolve binaries from it; never edited)
//   FIXER_BASE_BRANCH        MR/PR target branch (default: main)
//   FIXER_TARGET             scratch | real (default: scratch)
//   FIXER_ARTIFACTS_DIR      per-run artifacts root (default <repoParent>/.issue-fixer-artifacts)
//   FIXER_TRACKER            none | lark-base
//   FIXER_BASE_TOKEN / FIXER_TABLE_ID / FIXER_VIEW_ID / FIXER_SCRATCH_BASE_TOKEN / FIXER_SCRATCH_TABLE_ID
//   FIXER_NOTIFY             stdout | lark        FIXER_NOTIFY_OPEN_ID
//   FIXER_REPORT             markdown | lark-docx | custom   FIXER_REPORT_PUBLISH_CMD
//   FIXER_FORGE              git | github | custom           FIXER_FORGE_REPO
//   FIXER_MR_COMMAND / FIXER_MR_LIST_COMMAND                 custom forge templates
//   FIXER_INSTALL / FIXER_LINT / FIXER_TYPECHECK / FIXER_TEST
//   FIXER_DEV_SERVER_CMD / FIXER_PRODUCT_ENTRY_URL
//   FIXER_AUTH_TOKEN_VARS / FIXER_AUTH_TOKEN_CMD / FIXER_AUTH_HEADER / FIXER_AUTH_INIT_SCRIPT
//   FIXER_ENV_HEADERS        JSON template for real-env capture, e.g. {"x-env":"{env}","x-preview":"1"}
//   FIXER_DEPLOY_COMMAND / FIXER_ENV_FIND_COMMAND
//   FIXER_WORKITEM_FETCH_CMD optional read-only work-item fetcher for workitem-quick-fix
//   FIXER_REPO_RULES        JSON array of repo conventions surfaced to the agent
//   FIXER_HOST              none | cognia — host plane shared by notify/progress/bots
//   FIXER_HOST_BIN / FIXER_HOST_SESSION_ID   (aliases: FIXER_COGNIA_BIN / _SESSION_ID)
//   FIXER_PROGRESS_PUSH    1 = also push progress blocks to the bound host session
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const parseJson = (value, name) => {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`)
  }
}

const DEFAULTS = {
  target: 'scratch',
  repoDir: '',
  baseBranch: 'main',
  artifactsDir: '',
  worktree: {
    // worktree = isolated sibling worktree (default, safest).
    // in-place = work directly on a branch in the main checkout — for very large
    // repos where a second checkout is too expensive. Requires explicit opt-in.
    mode: 'worktree', // worktree | in-place
    // in-place mode only: branch to work on. Empty = stay on the current branch.
    inPlaceBranch: '',
    // {repoParent},{repoName},{issueId},{slug} are substituted.
    dirTemplate: '{repoParent}/{repoName}-fix-{issueId}',
    branchPrefix: 'fix/agent-',
  },
  tracker: {
    type: 'none', // none | lark-base
    baseToken: '',
    tableId: '',
    viewId: '',
    scratchBaseToken: '',
    scratchTableId: '',
    identity: 'user', // lark identity used for reads
    // Semantic field names of the tracking table. Defaults match the built-in lark-base adapter.
    fields: {
      description: '问题描述',
      module: '功能模块',
      priority: '优先级',
      reporter: '提出人',
      status: '状态',
      screenshot: '问题截图',
      note: '备注',
      noteText: '备注描述',
      follower: '跟进人',
      parent: '父记录',
    },
    fieldIds: {},
    status: { open: '待修复', claimed: '修复中', done: '待验收', fixed: '已修复' },
  },
  forge: {
    type: 'git', // git | github | custom
    repo: '',
    mrCommand: '', // custom template; {repo} {head} {base} {title} {bodyFile} substituted
    mrListCommand: '', // optional dedup lister; {repo} {head} substituted, must print JSON array or objects
  },
  notify: {
    type: 'stdout', // stdout | lark | cognia
    openId: '',
    chatId: '', // oc_* group chat — when set, the card goes to the group instead of a DM
    // Cognia bot facilities: deliver through the host's connector_send command
    // plane (bound conversation) instead of a direct DM. Needs a session id and
    // the cognia-agent CLI (PATH, or <repoDir>/cli/dist/cognia-agent.mjs).
    // Prefer the shared `host` block; these stay for back-compat.
    cogniaSessionId: '',
    cogniaBin: '',
  },
  host: {
    // Host plane the run can lean on beyond notification (bots, tasks, workflows,
    // connector_send). `cognia` = the Cognia host; `none` = pure local CLI mode.
    type: 'none', // none | cognia
    cogniaBin: '', // explicit CLI path; falls back to PATH then repo dist
    sessionId: '', // bound session for connector_send and friends
  },
  report: {
    type: 'markdown', // markdown | lark-docx | custom
    publishCommand: '', // custom template; {file} {name} substituted, must print a URL
    timezone: 'UTC', // IANA tz for ci-report windows, e.g. 'Asia/Shanghai'
  },
  verify: {
    install: '',
    lint: '',
    typecheck: '',
    test: '',
  },
  capture: {
    productEntryUrl: '',
    devServerCommand: '',
    playwrightDirs: [],
    authTokenVars: ['E2E_AUTH_TOKEN', 'AUTH_TOKEN', 'USER_JWT'],
    authTokenCommand: '',
    authHeader: 'x-jwt-token',
    authInitScript: '',
    envHeaders: {},
  },
  deploy: {
    deployCommand: '', // {branch} {env} {targets}
    envFindCommand: '', // {keyword}
  },
  workitemFetchCommand: '',
  // Analytics/tracking surface for tracking-doc: regex sources matched per line
  // to find call sites, plus path fragments to exclude. Extend per target repo —
  // the defaults cover common track/capture/analytics conventions.
  analytics: {
    patterns: [],
    exclude: [],
  },
  // User-path mindmap: the target repo owns the tree.json source plus its own
  // lint/build/push commands — this plugin supplies the workflow discipline,
  // never the generator itself.
  mindmap: {
    dir: '',            // default <repoDir>/docs/user-path-mindmap
    lintCommand: '',    // e.g. "node docs/user-path-mindmap/lint-tree.cjs"
    buildCommand: '',   // regenerate derived artifacts (diagram/openapi)
    pushCommand: '',    // push to a shared whiteboard/board — gated, optional
  },
  progressMarker: 'fixer:progress',
  // Repo-specific conventions injected into context — hard rules the fix must obey
  // (test placement, i18n, commit/changeset policy). Session-start echoes them.
  repoRules: [],
}

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

const merge = (base, extra) => {
  if (!isPlainObject(base) || !isPlainObject(extra)) return extra === undefined ? base : extra
  const out = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    out[key] = key in out ? merge(out[key], value) : value
  }
  return out
}

const findConfigFile = (repoDir) => {
  const candidates = []
  if (process.env.FIXER_CONFIG) candidates.push(process.env.FIXER_CONFIG)
  if (repoDir) {
    candidates.push(join(repoDir, 'fixer.config.json'))
    candidates.push(join(repoDir, '.fixer', 'config.json'))
  }
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null
}

let cached = null

/** Resolve the effective config. `overrides` wins over env, which wins over the config file. */
export function loadConfig(overrides = {}) {
  const envRepoDir = process.env.FIXER_REPO_DIR || ''
  const file = findConfigFile(envRepoDir || overrides.repoDir || '')
  let fileConfig = {}
  if (file) {
    try {
      fileConfig = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`cannot parse ${file}: ${error.message}`)
    }
  }

  const env = {
    ...(process.env.FIXER_TARGET && { target: process.env.FIXER_TARGET }),
    ...(envRepoDir && { repoDir: envRepoDir }),
    ...(process.env.FIXER_BASE_BRANCH && { baseBranch: process.env.FIXER_BASE_BRANCH }),
    ...(process.env.FIXER_ARTIFACTS_DIR && { artifactsDir: process.env.FIXER_ARTIFACTS_DIR }),
    worktree: {
      ...(process.env.FIXER_WORKTREE_MODE && { mode: process.env.FIXER_WORKTREE_MODE }),
      ...(process.env.FIXER_IN_PLACE_BRANCH && { inPlaceBranch: process.env.FIXER_IN_PLACE_BRANCH }),
    },
    tracker: {
      ...(process.env.FIXER_TRACKER && { type: process.env.FIXER_TRACKER }),
      ...(process.env.FIXER_BASE_TOKEN && { baseToken: process.env.FIXER_BASE_TOKEN }),
      ...(process.env.FIXER_TABLE_ID && { tableId: process.env.FIXER_TABLE_ID }),
      ...(process.env.FIXER_VIEW_ID && { viewId: process.env.FIXER_VIEW_ID }),
      ...(process.env.FIXER_SCRATCH_BASE_TOKEN && { scratchBaseToken: process.env.FIXER_SCRATCH_BASE_TOKEN }),
      ...(process.env.FIXER_SCRATCH_TABLE_ID && { scratchTableId: process.env.FIXER_SCRATCH_TABLE_ID }),
      ...(process.env.FIXER_LARK_AS && { identity: process.env.FIXER_LARK_AS }),
      ...(process.env.FIXER_TRACKER_FIELDS && { fields: parseJson(process.env.FIXER_TRACKER_FIELDS, 'FIXER_TRACKER_FIELDS') }),
      ...(process.env.FIXER_TRACKER_FIELD_IDS && { fieldIds: parseJson(process.env.FIXER_TRACKER_FIELD_IDS, 'FIXER_TRACKER_FIELD_IDS') }),
    },
    forge: {
      ...(process.env.FIXER_FORGE && { type: process.env.FIXER_FORGE }),
      ...(process.env.FIXER_FORGE_REPO && { repo: process.env.FIXER_FORGE_REPO }),
      ...(process.env.FIXER_MR_COMMAND && { mrCommand: process.env.FIXER_MR_COMMAND }),
      ...(process.env.FIXER_MR_LIST_COMMAND && { mrListCommand: process.env.FIXER_MR_LIST_COMMAND }),
    },
    notify: {
      ...(process.env.FIXER_NOTIFY && { type: process.env.FIXER_NOTIFY }),
      ...(process.env.FIXER_NOTIFY_OPEN_ID && { openId: process.env.FIXER_NOTIFY_OPEN_ID }),
      ...(process.env.FIXER_NOTIFY_CHAT_ID && { chatId: process.env.FIXER_NOTIFY_CHAT_ID }),
      ...(process.env.FIXER_COGNIA_SESSION_ID && { cogniaSessionId: process.env.FIXER_COGNIA_SESSION_ID }),
      ...(process.env.COGNIA_SESSION_ID && !process.env.FIXER_COGNIA_SESSION_ID && { cogniaSessionId: process.env.COGNIA_SESSION_ID }),
      ...(process.env.FIXER_COGNIA_BIN && { cogniaBin: process.env.FIXER_COGNIA_BIN }),
    },
    report: {
      ...(process.env.FIXER_REPORT && { type: process.env.FIXER_REPORT }),
      ...(process.env.FIXER_REPORT_PUBLISH_CMD && { publishCommand: process.env.FIXER_REPORT_PUBLISH_CMD }),
    },
    verify: {
      ...(process.env.FIXER_INSTALL && { install: process.env.FIXER_INSTALL }),
      ...(process.env.FIXER_LINT && { lint: process.env.FIXER_LINT }),
      ...(process.env.FIXER_TYPECHECK && { typecheck: process.env.FIXER_TYPECHECK }),
      ...(process.env.FIXER_TEST && { test: process.env.FIXER_TEST }),
    },
    capture: {
      ...(process.env.FIXER_PRODUCT_ENTRY_URL && { productEntryUrl: process.env.FIXER_PRODUCT_ENTRY_URL }),
      ...(process.env.FIXER_DEV_SERVER_CMD && { devServerCommand: process.env.FIXER_DEV_SERVER_CMD }),
      ...(process.env.FIXER_PLAYWRIGHT_DIRS && { playwrightDirs: process.env.FIXER_PLAYWRIGHT_DIRS.split(/[,:]/).filter(Boolean) }),
      ...(process.env.FIXER_AUTH_TOKEN_VARS && { authTokenVars: process.env.FIXER_AUTH_TOKEN_VARS.split(',').map((v) => v.trim()).filter(Boolean) }),
      ...(process.env.FIXER_AUTH_TOKEN_CMD && { authTokenCommand: process.env.FIXER_AUTH_TOKEN_CMD }),
      ...(process.env.FIXER_AUTH_HEADER && { authHeader: process.env.FIXER_AUTH_HEADER }),
      ...(process.env.FIXER_AUTH_INIT_SCRIPT && { authInitScript: process.env.FIXER_AUTH_INIT_SCRIPT }),
      ...(process.env.FIXER_ENV_HEADERS && { envHeaders: parseJson(process.env.FIXER_ENV_HEADERS, 'FIXER_ENV_HEADERS') }),
    },
    deploy: {
      ...(process.env.FIXER_DEPLOY_COMMAND && { deployCommand: process.env.FIXER_DEPLOY_COMMAND }),
      ...(process.env.FIXER_ENV_FIND_COMMAND && { envFindCommand: process.env.FIXER_ENV_FIND_COMMAND }),
    },
    host: {
      ...(process.env.FIXER_HOST && { type: process.env.FIXER_HOST }),
      ...((process.env.FIXER_HOST_BIN || process.env.FIXER_COGNIA_BIN) && { cogniaBin: process.env.FIXER_HOST_BIN || process.env.FIXER_COGNIA_BIN }),
      ...((process.env.FIXER_HOST_SESSION_ID || process.env.FIXER_COGNIA_SESSION_ID) && { sessionId: process.env.FIXER_HOST_SESSION_ID || process.env.FIXER_COGNIA_SESSION_ID }),
    },
    ...(process.env.FIXER_WORKITEM_FETCH_CMD && { workitemFetchCommand: process.env.FIXER_WORKITEM_FETCH_CMD }),
    ...(process.env.FIXER_REPO_RULES && { repoRules: parseJson(process.env.FIXER_REPO_RULES, 'FIXER_REPO_RULES') }),
    ...(process.env.FIXER_PROGRESS_PUSH && { progressPush: process.env.FIXER_PROGRESS_PUSH === '1' }),
  }

  const cfg = merge(merge(merge(DEFAULTS, fileConfig), env), overrides)
  cfg.repoDir = cfg.repoDir ? resolve(cfg.repoDir) : ''
  if (!cfg.artifactsDir && cfg.repoDir) {
    cfg.artifactsDir = join(dirname(cfg.repoDir), '.issue-fixer-artifacts')
  }
  cfg.configFile = file
  return cfg
}

/** Cached config for script entry points; pass `{ refresh: true }` to re-resolve. */
export function getConfig({ refresh } = {}) {
  if (!cached || refresh) cached = loadConfig()
  return cached
}

/** Effective tracker table: writes in scratch mode go to the scratch table when configured. */
export function trackerTable(cfg, { forWrite = false } = {}) {
  const t = cfg.tracker
  if (forWrite && cfg.target !== 'real' && t.scratchBaseToken && t.scratchTableId) {
    return { baseToken: t.scratchBaseToken, tableId: t.scratchTableId, scratch: true }
  }
  return { baseToken: t.baseToken, tableId: t.tableId, scratch: false }
}

/** Refuse writes to the production tracking table unless target=real. */
export function assertTrackerWritable(cfg) {
  if (cfg.tracker.type === 'none') throw new Error('tracker is not configured (tracker.type=none)')
  if (cfg.target === 'real') return
  const { scratch } = trackerTable(cfg, { forWrite: true })
  if (!scratch) {
    throw new Error(
      `[scratch-guard] refusing to write the production tracker while FIXER_TARGET=${cfg.target}. ` +
        'Set FIXER_TARGET=real for a greenlit production run, or configure tracker.scratchBaseToken/scratchTableId.',
    )
  }
}

/** Interpolate {placeholders} in a command template. */
export function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (!(key in vars)) throw new Error(`unknown template variable ${match} in "${template}"`)
    return String(vars[key])
  })
}

/** True when the run works directly on a branch in the main checkout (no worktree). */
export function isInPlaceMode(cfg) {
  return cfg.worktree?.mode === 'in-place'
}

/** Expand the worktree dir template for a given issue. */
export function worktreePathFor(cfg, issueId) {
  const repoDir = cfg.repoDir
  const repoName = repoDir.split('/').filter(Boolean).pop() || 'repo'
  const rendered = renderTemplate(cfg.worktree.dirTemplate, {
    repoParent: dirname(repoDir),
    repoName,
    issueId,
    slug: issueId,
  })
  return isAbsolute(rendered) ? rendered : resolve(dirname(repoDir), rendered)
}

export function branchNameFor(cfg, issueId) {
  return `${cfg.worktree.branchPrefix}${issueId}`
}
