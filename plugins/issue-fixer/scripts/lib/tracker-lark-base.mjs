// lark-base tracker adapter: Lark Base（多维表格）as the issue tracker, via lark-cli.
// Field names, status values, and scratch-table routing all come from config.mjs —
// the adapter itself is table-agnostic.
import { assertTrackerWritable, trackerTable } from './config.mjs'
import { runLark } from './lark.mjs'

function recordFromColumnar(data, i = 0) {
  const names = data.fields || []
  const row = (data.data || [])[i] || []
  const fields = {}
  names.forEach((name, idx) => (fields[name] = row[idx]))
  return { recordId: (data.record_id_list || [])[i], fields }
}

export function makeLarkBaseTracker(cfg) {
  const t = cfg.tracker
  const as = t.identity || 'user'
  const F = t.fields
  const table = (forWrite) => {
    const target = trackerTable(cfg, { forWrite })
    if (!target.baseToken || !target.tableId) {
      throw new Error('lark-base tracker requires tracker.baseToken + tracker.tableId (or FIXER_BASE_TOKEN/FIXER_TABLE_ID)')
    }
    return target
  }

  const getRecord = async (recordId) => {
    const { baseToken, tableId } = table(false)
    const env = await runLark(
      ['base', '+record-get', '--base-token', baseToken, '--table-id', tableId, '--record-id', recordId, '--format', 'json'],
      { as },
    )
    return recordFromColumnar(env.data, 0)
  }

  /** List records by status field (default tracker.status.open), filtered server-side. */
  const listByStatus = async (status = t.status.open) => {
    const { baseToken, tableId } = table(false)
    const argv = ['base', '+record-list', '--base-token', baseToken, '--table-id', tableId, '--format', 'json', '--limit', '200']
    if (status) argv.push('--filter-json', JSON.stringify({ logic: 'and', conditions: [[F.status, '==', status]] }))
    const env = await runLark(argv, { as })
    const d = env.data || {}
    const out = (d.data || []).map((_, i) => recordFromColumnar(d, i))
    if (d.has_more) console.error(`[tracker] warning: has_more=true — >200 "${status}" records; only the first 200 returned (record-list has no page-token flag; narrow the filter).`)
    return out
  }

  /** List records in table VIEW order (what the user sees). Index is 1-based. */
  const listByView = async () => {
    const { baseToken, tableId } = table(false)
    const env = await runLark(
      ['base', '+record-list', '--base-token', baseToken, '--table-id', tableId, '--view-id', t.viewId, '--format', 'json', '--limit', '200'],
      { as },
    )
    const d = env.data || {}
    const out = (d.data || []).map((_, i) => recordFromColumnar(d, i))
    if (d.has_more) console.error('[tracker] warning: view has >200 rows; only the first 200 are indexable.')
    return out
  }

  /**
   * Resolve a human-friendly selector to a record_id:
   *  - `recXXXX`      -> itself (lark-base record id)
   *  - `#N` / `N`     -> the Nth row (1-based) in the table VIEW order
   *  - `<status>#N`   -> the Nth row (1-based) filtered to that status value
   */
  const resolveRecordId = async (selector) => {
    const sel = String(selector ?? '').trim()
    if (/^rec[A-Za-z0-9]+$/.test(sel)) return { recordId: sel, how: 'record_id' }
    const m = sel.match(/^(.+?)\s*#\s*(\d+)$/)
    if (m && !/^\d+$/.test(m[1])) {
      const rows = await listByStatus(m[1])
      const r = rows[Number(m[2]) - 1]
      if (!r) throw new Error(`no #${m[2]} record with ${F.status}=${m[1]} (only ${rows.length})`)
      return { recordId: r.recordId, how: `${m[1]}#${m[2]}`, record: r }
    }
    const n = sel.replace(/^#/, '')
    if (/^\d+$/.test(n)) {
      const rows = await listByView()
      const r = rows[Number(n) - 1]
      if (!r) throw new Error(`no row #${n} in the view (only ${rows.length} rows)`)
      return { recordId: r.recordId, how: `view#${n}`, record: r }
    }
    throw new Error(`unrecognized selector "${sel}" — use a record id, #N (view row), or "<status>#N"`)
  }

  /** Update a record's writable (non-attachment) fields. Scratch-guarded. */
  const updateRecord = async (recordId, fieldMap) => {
    assertTrackerWritable(cfg)
    const { baseToken, tableId } = table(true)
    const env = await runLark(
      ['base', '+record-upsert', '--base-token', baseToken, '--table-id', tableId, '--record-id', recordId, '--json', JSON.stringify(fieldMap), '--format', 'json'],
      { as },
    )
    return env.data
  }

  /** Append local files to an attachment cell. Scratch-guarded. */
  const uploadAttachment = async (recordId, fieldIdOrName, files) => {
    assertTrackerWritable(cfg)
    const { baseToken, tableId } = table(true)
    const argv = ['base', '+record-upload-attachment', '--base-token', baseToken, '--table-id', tableId, '--record-id', recordId, '--field-id', fieldIdOrName, '--format', 'json']
    for (const f of [].concat(files)) argv.push('--file', f)
    const env = await runLark(argv, { as })
    return env.data
  }

  const downloadAttachments = async (recordId, outDir) => {
    const { baseToken, tableId } = table(false)
    return runLark(
      ['base', '+record-download-attachment', '--base-token', baseToken, '--table-id', tableId, '--record-id', recordId, '--output', outDir],
      { as, allowError: true },
    )
  }

  const recordUrl = (recordId) => {
    const { baseToken, tableId } = table(false)
    const tpl = t.recordUrlTemplate || 'https://bytedance.larkoffice.com/base/{baseToken}?table={tableId}'
    return tpl.replace('{baseToken}', baseToken).replace('{tableId}', tableId).replace('{recordId}', recordId || '')
  }

  return {
    type: 'lark-base',
    fields: F,
    status: t.status,
    fieldIds: t.fieldIds || {},
    resolveRecordId,
    getRecord,
    listByStatus,
    listByView,
    claim: (recordId) => updateRecord(recordId, { [F.status]: t.status.claimed }),
    updateRecord,
    uploadAttachment,
    downloadAttachments,
    recordUrl,
  }
}
