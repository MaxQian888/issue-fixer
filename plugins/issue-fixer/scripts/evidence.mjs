// CLI for the Lark-linked evidence collector.
//   node evidence.mjs collect --text "<raw input>"        --out <runDir>/evidence
//   node evidence.mjs collect --text-file <file>          --out <dir>
//   node evidence.mjs collect --record-file <record.json> --out <dir>   # scans all record fields
// Prints the manifest JSON. Links that need human judgment come back status=manual.
import { readFileSync } from 'node:fs'
import { collectLarkEvidence, extractLarkLinks, textFromRecord } from './lib/evidence.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const run = async () => {
  const [cmd] = args
  if (cmd === 'scan') {
    const text = flag('--text') ?? (flag('--text-file') ? readFileSync(flag('--text-file'), 'utf8') : '')
    console.log(JSON.stringify(extractLarkLinks(text), null, 2))
    return
  }
  if (cmd !== 'collect') {
    console.error('usage: evidence.mjs scan|collect --text <s>|--text-file <f>|--record-file <f> --out <dir>')
    process.exit(2)
  }
  const out = flag('--out')
  if (!out) {
    console.error('collect requires --out <dir>')
    process.exit(2)
  }
  let text = flag('--text') || ''
  if (flag('--text-file')) text += `\n${readFileSync(flag('--text-file'), 'utf8')}`
  if (flag('--record-file')) text += `\n${textFromRecord(JSON.parse(readFileSync(flag('--record-file'), 'utf8')))}`
  console.log(JSON.stringify(await collectLarkEvidence(text, out), null, 2))
}

run().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
