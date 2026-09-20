// Notify adapter — delivers the "fix delivered" card/message to the reporter or operator.
// Types:
//   stdout — prints the built notification; always available, the default.
//   lark   — interactive card (Card 2.0). Deployed runtime: publishes one event
//            through the deployment's configured connector package
//            (FIXER_CONNECTOR_PACKAGE / _COMMAND / _METHOD + FIXER_AGENT_SERVER_WS /
//            FIXER_AGENT_THREAD_ID), which the running message bridge delivers.
//            Local fallback: `lark-cli im` DM/group card. In scratch mode the DM
//            is forced to notify.openId (the operator), never the real reporter.
//   cognia — reuse the host app's bot facilities: `cognia-agent api call
//            connector_send` delivers markdown segments to the session's bound
//            conversation (governed outbound path — works for Lark-bound or any
//            other connector the host owns). Bin/session resolution lives in
//            lib/cognia.mjs (shared host-plane client).
//
// CLI: node notify.mjs send <modelJsonFile>
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getConfig } from './config.mjs'
import { cogniaApiCall, cogniaBinFor, cogniaSessionIdFor } from './cognia.mjs'
import { larkResolveUser, larkWhoami, runLark } from './lark.mjs'

const execFileAsync = promisify(execFile)
const PLUGIN_NAME = 'issue-fixer'

/** Render the fix card model as plain markdown (used by segment-based backends). */
export function buildFixMarkdown(m) {
  const lines = [`**${m.title || '已修复一个问题'}**`]
  if (m.module || m.priority) lines.push(`模块：${m.module || '-'}　优先级：${m.priority || '-'}`)
  if (m.issueDesc) lines.push(`问题：${m.issueDesc}`)
  if (m.locateFile) lines.push(`定位：\`${m.locateFile}\``)
  if (m.planSummary) lines.push(`方案：${m.planSummary}`)
  if (m.verify) lines.push(`验证：${m.verify}`)
  if (m.beforeAfterNote) lines.push(`对比：${m.beforeAfterNote}`)
  const links = [
    m.mrUrl && `[MR](${m.mrUrl})`,
    m.envUrl && `[环境](${m.envUrl})`,
    m.reportUrl && `[修改报告](${m.reportUrl})`,
    m.recordUrl && `[跟踪记录](${m.recordUrl})`,
  ].filter(Boolean)
  if (links.length) lines.push(links.join(' · '))
  return lines.join('\n')
}

/** Deployed runtime present? (connector no-ops without these env vars.) */
export function connectorAvailable() {
  return !!(
    process.env.FIXER_AGENT_SERVER_WS
    && process.env.FIXER_AGENT_THREAD_ID
    && process.env.FIXER_CONNECTOR_PACKAGE
  )
}

const HEADER_TEMPLATE = { done: 'green', running: 'blue', error: 'red', question: 'orange' }

/**
 * @param {object} m
 *   state, title, issueDesc, module, priority, recordUrl,
 *   locateFile, planSummary, verify, mrUrl, envUrl, reportUrl,
 *   beforeAfterNote, reporterOpenId, actions (optional [{text,value}])
 */
export function buildFixCard(m) {
  const els = []
  const kv = []
  if (m.module || m.priority) kv.push(`**模块**：${m.module || '-'}　**优先级**：${m.priority || '-'}`)
  if (m.issueDesc) kv.push(`**问题**：${m.issueDesc}`)
  if (m.locateFile) kv.push(`**定位**：\`${m.locateFile}\``)
  if (m.planSummary) kv.push(`**方案**：${m.planSummary}`)
  if (m.verify) kv.push(`**验证**：${m.verify}`)
  if (m.beforeAfterNote) kv.push(`**对比**：${m.beforeAfterNote}`)
  if (kv.length) els.push({ tag: 'markdown', content: kv.join('\n') })

  const links = []
  if (m.mrUrl) links.push(`[🔀 MR](${m.mrUrl})`)
  if (m.envUrl) links.push(`[🚀 环境](${m.envUrl})`)
  if (m.reportUrl) links.push(`[📄 修改报告](${m.reportUrl})`)
  if (m.recordUrl) links.push(`[📋 跟踪记录](${m.recordUrl})`)
  if (links.length) {
    els.push({ tag: 'hr' })
    els.push({ tag: 'markdown', content: links.join('　·　') })
  }

  // Optional HIL buttons (approve / reject). Callbacks only route in deployed mode.
  if (Array.isArray(m.actions) && m.actions.length) {
    els.push({
      tag: 'action',
      actions: m.actions.map((a) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: a.text },
        type: a.type || 'primary',
        behaviors: [{ type: 'callback', value: a.value || { action: a.text } }],
      })),
    })
  }

  if (m.reporterOpenId) {
    els.push({ tag: 'hr' })
    els.push({ tag: 'markdown', content: `提出人：<at id=${m.reporterOpenId}></at>` })
  }

  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: m.title || '已修复一个问题' },
      template: HEADER_TEMPLATE[m.state || 'done'] || 'blue',
    },
    body: { elements: els },
  }
}

/** Lark backend: card via lark-cli. Bot is the sender; DM by open_id or group by chatId. */
export async function sendCard(target, card, { as = 'bot' } = {}) {
  const idFlag = target.chatId
    ? ['--chat-id', target.chatId]
    : ['--user-id', target.openId || target]
  return runLark(
    ['im', '+messages-send', ...idFlag, '--msg-type', 'interactive', '--content', JSON.stringify(card)],
    { as },
  )
}

/**
 * Lark deployed backend: publish ONE event carrying the raw card via the deployment's
 * connector package (all FIXER_* configurable), which the running message bridge delivers.
 * mention = array of open_ids to @ (empty = none).
 * Requires FIXER_CONNECTOR_PACKAGE; FIXER_CONNECTOR_METHOD defaults to
 * `plugin/event/publish` — override for other runtimes.
 */
export async function publishCardViaConnector(card, { title = '已修复一个问题', mention = [], eventName = 'issue-fixer.fix.reported', clientEventId } = {}) {
  const pkg = process.env.FIXER_CONNECTOR_PACKAGE
  if (!pkg) throw new Error('connector backend requires FIXER_CONNECTOR_PACKAGE')
  const ver = process.env.FIXER_CONNECTOR_VERSION
  const bin = process.env.FIXER_CONNECTOR_COMMAND || 'connector'
  const method = process.env.FIXER_CONNECTOR_METHOD || 'plugin/event/publish'
  const runId = process.env.FIXER_RUN_ID
  const params = {
    threadId: process.env.FIXER_AGENT_THREAD_ID,
    pluginName: PLUGIN_NAME,
    instanceId: PLUGIN_NAME,
    eventName,
    source: 'custom_plugin',
    clientEventId: clientEventId || `${PLUGIN_NAME}-${Date.now()}`,
    ...(runId ? { runId, taskId: runId } : {}),
    payload: {
      title,
      content: title,
      notificationConfig: {
        larkMessage: {
          enable: true,
          msgType: 'interactive',
          mode: 'raw_card',
          mention: { enable: mention.length > 0, userList: mention },
          content: card,
        },
      },
    },
  }
  const argv = ['-y', '-p', ver ? `${pkg}@${ver}` : pkg, bin, 'request', method, '--params', JSON.stringify(params), '--plugin-name', PLUGIN_NAME, '--instance-id', PLUGIN_NAME, '--silent']
  const { stdout } = await execFileAsync('npx', argv, { maxBuffer: 16 * 1024 * 1024 })
  return { ok: true, via: 'connector', stdout: stdout.trim().slice(0, 400) }
}

// Re-exported: bin/session resolution moved to lib/cognia.mjs (the shared host
// plane client). Kept on this module's surface for callers that already import it.
export { cogniaBinFor }

/** Cognia bot facilities reachable: session id + a resolvable cognia-agent. */
export function cogniaAvailable(cfg) {
  return !!(cogniaSessionIdFor(cfg) && cogniaBinFor(cfg))
}

/**
 * Deliver via the Cognia host's command plane: `api call connector_send` posts
 * markdown segments into the session's bound conversation — the governed
 * outbound path the host's own bots use (delivery-gateway, principal rules).
 * Requires a session id (host.sessionId / notify.cogniaSessionId / env) and a
 * resolvable cognia-agent; host auth comes from the saved host or
 * COGNIA_ENDPOINT + COGNIA_SERVICE_TOKEN env.
 */
export async function sendViaCognia(model, { cfg = getConfig() } = {}) {
  const sessionId = cogniaSessionIdFor(cfg)
  if (!sessionId) throw new Error('notify.type=cognia requires host.sessionId / notify.cogniaSessionId / FIXER_/COGNIA_SESSION_ID')
  const segments = [{ type: 'markdown', md: buildFixMarkdown(model) }]
  await cogniaApiCall('connector_send', ['--session-id', sessionId, '--segments', JSON.stringify(segments)], { cfg })
  return { ok: true, via: 'cognia' }
}

/**
 * Backend-agnostic delivery. `model` is the buildFixCard model + {target, notifyOpenId}.
 * notify.type=stdout prints; notify.type=lark uses connector in deployed runtime,
 * lark-cli DM locally (scratch mode forces the operator, never the real reporter).
 */
export async function deliverFixNotification(model, { cfg = getConfig(), backend = 'auto' } = {}) {
  if (cfg.notify.type === 'cognia') {
    return sendViaCognia(model, { cfg })
  }
  if (cfg.notify.type === 'stdout') {
    const text = [
      `[notify:stdout] ${model.title || '已修复一个问题'}`,
      model.issueDesc && `问题：${model.issueDesc}`,
      model.locateFile && `定位：${model.locateFile}`,
      model.mrUrl && `MR：${model.mrUrl}`,
      model.reportUrl && `报告：${model.reportUrl}`,
    ].filter(Boolean).join('\n')
    process.stdout.write(`${text}\n`)
    return { ok: true, via: 'stdout' }
  }
  const card = buildFixCard(model)
  const useConnector = backend === 'connector' || (backend === 'auto' && connectorAvailable())
  if (useConnector) {
    const mention = model.target === 'real' && model.reporterOpenId ? [model.reporterOpenId] : []
    return publishCardViaConnector(card, { title: model.title, mention })
  }
  // Group-chat card wins when configured — explicit config, so it is honored in both
  // scratch and real mode (it never derives from the reporter identity).
  if (cfg.notify.chatId) return sendCard({ chatId: cfg.notify.chatId }, card)

  // Local DM target: explicit model/config wins; otherwise the operator identity
  // from `lark-cli whoami` — which in scratch mode is exactly who should get the card.
  let openId = model.notifyOpenId || cfg.notify.openId || model.reporterOpenId
  if (!openId) {
    const me = await larkWhoami()
    if (me.ok && me.openId) openId = me.openId
  }
  if (!openId) throw new Error('deliverFixNotification: no notifyOpenId — set notify.openId, notify.chatId, or login with lark-cli (`lark-cli auth login`)')
  // notify.openId may be a name/email instead of ou_* — resolve via contact search.
  if (!/^ou_[A-Za-z0-9_-]+$/.test(openId)) {
    const hit = await larkResolveUser(openId)
    if (!hit.ok || !hit.openId) {
      throw new Error(`deliverFixNotification: cannot resolve "${openId}" to an open_id (${hit.reason || 'no match'})`)
    }
    if (hit.ambiguous) {
      throw new Error(`deliverFixNotification: "${openId}" matches ${hit.count} users — set the exact ou_* open_id in notify.openId`)
    }
    openId = hit.openId
  }
  return sendCard({ openId }, card)
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const [cmd, file] = process.argv.slice(2)
  const run = async () => {
    if (cmd !== 'send') {
      console.error('usage: notify.mjs send <modelJsonFile>')
      process.exit(2)
    }
    const model = file
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { title: 'issue-fixer self-test', issueDesc: 'card render check', state: 'done' }
    console.log(JSON.stringify(await deliverFixNotification(model), null, 2))
  }
  run().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
