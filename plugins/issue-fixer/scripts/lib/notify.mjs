// Notify adapter — delivers the "fix delivered" card/message to the reporter or operator.
// Types:
//   stdout — prints the built notification; always available, the default.
//   lark   — interactive card (Card 2.0). Deployed runtime: publishes one
//            `plugin/event/publish` event through the configured connector package, which
//            the running message bridge delivers (same path as the ecosystem's notifiers —
//            never a hand-rolled WebSocket or direct OpenAPI call). Local fallback:
//            `lark-cli im` DM. In scratch mode the DM is forced to notify.openId (the
//            operator), never the real reporter.
//
// CLI: node notify.mjs send <modelJsonFile>
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getConfig } from './config.mjs'
import { larkWhoami, runLark } from './lark.mjs'

const execFileAsync = promisify(execFile)
const PLUGIN_NAME = 'issue-fixer'

/** Deployed runtime present? (connector no-ops without these env vars.) */
export function connectorAvailable() {
  return !!(process.env.AIDEN_AGENT_SERVER_WS && process.env.AIDEN_AGENT_THREAD_ID)
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

/** Lark backend: DM via lark-cli. Bot is the sender. */
export async function sendCard(openId, card, { as = 'bot' } = {}) {
  return runLark(
    ['im', '+messages-send', '--user-id', openId, '--msg-type', 'interactive', '--content', JSON.stringify(card)],
    { as },
  )
}

/**
 * Lark deployed backend: publish ONE `plugin/event/publish` event carrying the raw card via
 * the connector package (env-configurable), which the running message bridge delivers.
 * mention = array of open_ids to @ (empty = none).
 */
export async function publishCardViaConnector(card, { title = '已修复一个问题', mention = [], eventName = 'issue-fixer.fix.reported', clientEventId } = {}) {
  const pkg = process.env.FIXER_CONNECTOR_PACKAGE || '@aiden-ai/connector'
  const ver = process.env.FIXER_CONNECTOR_VERSION || '0.0.9'
  const bin = process.env.FIXER_CONNECTOR_COMMAND || 'aiden-connector'
  const runId = process.env.SDMA_SERVER_RUN_ID || process.env.AIDEN_AGENT_RUN_ID
  const params = {
    threadId: process.env.AIDEN_AGENT_THREAD_ID,
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
  const argv = ['-y', '-p', `${pkg}@${ver}`, bin, 'request', 'plugin/event/publish', '--params', JSON.stringify(params), '--plugin-name', PLUGIN_NAME, '--instance-id', PLUGIN_NAME, '--silent']
  const { stdout } = await execFileAsync('npx', argv, { maxBuffer: 16 * 1024 * 1024 })
  return { ok: true, via: 'connector', stdout: stdout.trim().slice(0, 400) }
}

/**
 * Backend-agnostic delivery. `model` is the buildFixCard model + {target, notifyOpenId}.
 * notify.type=stdout prints; notify.type=lark uses connector in deployed runtime,
 * lark-cli DM locally (scratch mode forces the operator, never the real reporter).
 */
export async function deliverFixNotification(model, { cfg = getConfig(), backend = 'auto' } = {}) {
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
  // Local DM target: explicit model/config wins; otherwise the operator identity
  // from `lark-cli whoami` — which in scratch mode is exactly who should get the card.
  let openId = model.notifyOpenId || cfg.notify.openId || model.reporterOpenId
  if (!openId) {
    const me = await larkWhoami()
    if (me.ok && me.openId) openId = me.openId
  }
  if (!openId) throw new Error('deliverFixNotification: no notifyOpenId — set notify.openId or login with lark-cli (`lark-cli auth login`)')
  return sendCard(openId, card)
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
