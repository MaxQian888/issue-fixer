// Issue tracker adapter facade + CLI. The orchestrator only ever talks to this facade;
// adding a tracker means implementing the same surface (resolveRecordId / getRecord /
// listByStatus / listByView / claim / updateRecord / uploadAttachment /
// downloadAttachments / recordUrl / fields / status) and registering it here.
//
// CLI (selector = record id | #N | "<status>#N"):
//   node tracker.mjs resolve <selector>
//   node tracker.mjs get <selector>
//   node tracker.mjs list [status]            # default: configured open status
//   node tracker.mjs claim <selector>         # status -> claimed (scratch-guarded)
//   node tracker.mjs writeback <selector> <json>
//   node tracker.mjs upload <selector> <fieldIdOrName> <file...>
//   node tracker.mjs download <selector> <outDir>
import { getConfig } from './config.mjs'
import { makeLarkBaseTracker } from './tracker-lark-base.mjs'

export function getTracker(cfg = getConfig()) {
  switch (cfg.tracker.type) {
    case 'lark-base':
      return makeLarkBaseTracker(cfg)
    case 'none':
      return null
    default:
      throw new Error(`unknown tracker type "${cfg.tracker.type}" — supported: none | lark-base`)
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2)
  const run = async () => {
    const cfg = getConfig()
    const tracker = getTracker(cfg)
    if (!tracker) {
      throw new Error('tracker.type=none — this run has no issue tracker; use direct-evidence mode')
    }
    const rid = async (sel) => (await tracker.resolveRecordId(sel)).recordId
    const F = tracker.fields
    const summarize = (r, i) => ({
      '#': i + 1,
      id: r.recordId,
      [F.description]: r.fields[F.description],
      [F.module]: r.fields[F.module],
      [F.priority]: r.fields[F.priority],
      [F.status]: Array.isArray(r.fields[F.status]) ? r.fields[F.status][0] : r.fields[F.status],
    })
    switch (cmd) {
      case 'preflight':
        console.log(JSON.stringify(
          typeof tracker.preflight === 'function' ? await tracker.preflight() : { ok: true, kind: 'ready' },
          null, 2,
        ))
        break
      case 'resolve':
        console.log(JSON.stringify(await tracker.resolveRecordId(rest[0]), null, 2))
        break
      case 'get':
        console.log(JSON.stringify(await tracker.getRecord(await rid(rest[0])), null, 2))
        break
      case 'list': {
        const rows = rest[0] ? await tracker.listByStatus(rest[0]) : await tracker.listByView()
        console.log(JSON.stringify(rows.map(summarize), null, 2))
        break
      }
      case 'claim':
        console.log(JSON.stringify(await tracker.claim(await rid(rest[0])), null, 2))
        break
      case 'writeback':
        console.log(JSON.stringify(await tracker.updateRecord(await rid(rest[0]), JSON.parse(rest[1])), null, 2))
        break
      case 'upload':
        console.log(JSON.stringify(await tracker.uploadAttachment(await rid(rest[0]), rest[1], rest.slice(2)), null, 2))
        break
      case 'download':
        console.log(JSON.stringify(await tracker.downloadAttachments(await rid(rest[0]), rest[1]), null, 2))
        break
      default:
        console.error('usage: tracker.mjs preflight|resolve|get|list|claim|writeback|upload|download <selector>  (selector = record id | #N | "<status>#N")')
        process.exit(2)
    }
  }
  run().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
