// Lark-linked evidence collector. Issue descriptions and direct-evidence input often
// contain links to Feishu/Lark resources — spec docs, wiki pages, minutes, chat
// messages with screenshots. This module extracts those links and fetches each
// through lark-cli into the run's evidence dir, so the agent reads real content
// instead of guessing from a URL.
//
// Link kinds handled:
//   docx | docs | wiki   -> `docs +fetch` (wiki resolved via `wiki +node-get` first)
//   minutes              -> `minutes +detail --summary --transcript`
//   message (om_/omt_)   -> `im +messages-mget --download-resources`
//   sheets | file        -> classified `manual` (needs a human-chosen range/path)
//   base                 -> skipped (that IS the tracker, handled by tracker.mjs)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runLark } from './lark.mjs'

const LARK_URL = /https?:\/\/[\w.-]*(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/(docx|docs|wiki|sheets|minutes|file|base|messenger)\/([A-Za-z0-9_-]+)/g
const MESSAGE_ID = /\b(om_[A-Za-z0-9]+|omt_[A-Za-z0-9]+)\b/g

/**
 * Extract Lark resource references from free text.
 * Returns [{ kind, token, url }] deduped by kind+token. kind ∈
 * docx|docs|wiki|sheets|minutes|file|base|message.
 */
export function extractLarkLinks(text) {
  const out = []
  const seen = new Set()
  const push = (kind, token, url) => {
    const key = `${kind}:${token}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, token, url })
  }
  for (const m of String(text ?? '').matchAll(LARK_URL)) {
    push(m[1] === 'docs' ? 'docx' : m[1], m[2], m[0])
  }
  for (const m of String(text ?? '').matchAll(MESSAGE_ID)) {
    push('message', m[1], m[1])
  }
  return out
}

/** Pull every string value out of a Base record's fields for scanning. */
export function textFromRecord(record) {
  const parts = []
  const walk = (v) => {
    if (v == null) return
    if (typeof v === 'string') parts.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(record?.fields || record)
  return parts.join('\n')
}

const safeName = (s) => String(s).replace(/[^\w.-]/g, '_').slice(0, 80)

async function fetchDocx(link, outDir) {
  // wiki links resolve to their real obj_token first; docs +fetch then reads it.
  let doc = link.url
  if (link.kind === 'wiki') {
    const node = await runLark(['wiki', '+node-get', '--node-token', link.url, '--format', 'json'], { allowError: true })
    const objToken = node.data?.node?.obj_token || node.data?.obj_token
    if (node.ok === false || !objToken) {
      return { status: 'failed', reason: `wiki node-get failed: ${node.error?.message || 'no obj_token'}` }
    }
    doc = objToken
  }
  const env = await runLark(['docs', '+fetch', '--doc', doc, '--doc-format', 'markdown'], { allowError: true })
  if (env.ok === false) return { status: 'failed', reason: env.error?.message || 'docs fetch failed' }
  const body = typeof env.raw === 'string' && env.raw.trim() ? env.raw : JSON.stringify(env.data ?? env, null, 2)
  const file = join(outDir, `${link.kind}-${safeName(link.token)}.md`)
  writeFileSync(file, body)
  return { status: 'fetched', file }
}

async function fetchMinutes(link, outDir) {
  const dir = join(outDir, `minutes-${safeName(link.token)}`)
  const env = await runLark(
    ['minutes', '+detail', '--minute-tokens', link.token, '--summary', '--transcript', '--output-dir', dir, '--format', 'json'],
    { allowError: true },
  )
  if (env.ok === false) return { status: 'failed', reason: env.error?.message || 'minutes detail failed' }
  return { status: 'fetched', file: dir, data: env.data }
}

async function fetchMessages(ids, outDir) {
  const env = await runLark(
    ['im', '+messages-mget', '--message-ids', ids.join(','), '--download-resources', '--format', 'json'],
    { allowError: true, cwd: outDir },
  )
  if (env.ok === false) return { status: 'failed', reason: env.error?.message || 'messages mget failed' }
  const file = join(outDir, 'messages.json')
  writeFileSync(file, JSON.stringify(env.data ?? env, null, 2))
  return { status: 'fetched', file }
}

/**
 * Fetch every Lark link found in `texts` into `outDir`.
 * Returns a manifest: [{ kind, token, url, status: fetched|manual|skipped|failed,
 * file?, reason? }] — also written to <outDir>/evidence-manifest.json.
 * Never throws per-item; a failed link is evidence too (surfaced as `failed`).
 */
export async function collectLarkEvidence(texts, outDir) {
  mkdirSync(outDir, { recursive: true })
  const links = extractLarkLinks([].concat(texts).join('\n'))
  const manifest = []
  const messageIds = []
  for (const link of links) {
    if (link.kind === 'base') {
      manifest.push({ ...link, status: 'skipped', reason: 'base link — handled by the tracker adapter' })
      continue
    }
    if (link.kind === 'message') {
      messageIds.push(link.token)
      manifest.push({ ...link, status: 'queued' })
      continue
    }
    if (link.kind === 'sheets' || link.kind === 'file' || link.kind === 'messenger') {
      manifest.push({ ...link, status: 'manual', reason: 'needs a human-chosen range/path — fetch manually via lark-cli' })
      continue
    }
    const fn = link.kind === 'minutes' ? fetchMinutes : fetchDocx
    const res = await fn(link, outDir).catch((e) => ({ status: 'failed', reason: e.message }))
    manifest.push({ ...link, ...res })
  }
  if (messageIds.length) {
    const res = await fetchMessages(messageIds, outDir).catch((e) => ({ status: 'failed', reason: e.message }))
    for (const item of manifest) {
      if (item.status === 'queued') Object.assign(item, res)
    }
  }
  writeFileSync(join(outDir, 'evidence-manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}
