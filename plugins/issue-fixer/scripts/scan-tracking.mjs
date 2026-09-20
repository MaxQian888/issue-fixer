#!/usr/bin/env node
// scan-tracking.mjs — heuristic analytics/tracking call-site scanner.
// Reads `analytics.patterns` (list of regex source strings matched against each
// line) and `analytics.exclude` (path fragments) from fixer config, walks the
// target paths, and emits JSON: per-event sites with kind report|declaration.
// It locates evidence; business semantics stay with the agent.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { getConfig } from './lib/config.mjs'

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.vue', '.svelte'])
const DECLARATION_PATH = /(const|enum|schema|catalog|registry|events?\.|tracking\.)/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '__snapshots__'])

const parseArgs = (argv) => {
  const out = { targets: [], candidates: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--candidates') out.candidates = true
    else if (a === '--root') out.root = argv[++i]
    else if (a === '--help') out.help = true
    else out.targets.push(a)
  }
  return out
}

const walk = (dir, out) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out)
    } else if (SOURCE_EXTS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      out.push(join(dir, entry.name))
    }
  }
}

// Extract the event identity: first string literal arg of the call, else mark dynamic.
const extractEvent = (line) => {
  const m = line.match(/\(\s*['"`]([^'"`]+)['"`]/)
  return m ? m[1] : '(dynamic)'
}

const classify = (file, line) => {
  const declFile = DECLARATION_PATH.test(file)
  const isCall = /\(/.test(line) && !/^\s*(import|export\s+type|type\s|interface\s)/.test(line)
  // A call inside a declaration-shaped file is still a report site (e.g. helpers).
  return isCall ? 'report' : declFile ? 'declaration' : 'report'
}

export const scan = (root, targets, patterns, exclude, { candidates = false } = {}) => {
  const regexes = patterns.map((p) => new RegExp(p))
  const excludes = exclude.map((e) => e.toLowerCase())
  const files = []
  for (const t of targets) {
    const abs = resolve(root, t)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, files)
    else files.push(abs)
  }
  const events = new Map()
  const candidateHits = []
  for (const file of files) {
    const rel = relative(root, file)
    if (excludes.some((e) => rel.toLowerCase().includes(e))) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!regexes.some((r) => r.test(line))) return
      const site = { file: rel, line: i + 1, kind: classify(rel, line), snippet: line.trim().slice(0, 200) }
      const event = extractEvent(line)
      if (event === '(dynamic)') {
        candidateHits.push({ ...site, reason: 'dynamic event name — needs manual review' })
        return
      }
      if (!events.has(event)) events.set(event, { event, sites: [] })
      events.get(event).sites.push(site)
    })
  }
  const catalog = [...events.values()].map((e) => ({
    ...e,
    status: e.sites.some((s) => s.kind === 'report') ? 'reported' : 'declared-only',
  }))
  catalog.sort((a, b) => a.event.localeCompare(b.event))
  return {
    root,
    patterns,
    filesScanned: files.length,
    eventCatalog: catalog,
    declaredButUnfired: catalog.filter((e) => e.status === 'declared-only').map((e) => e.event),
    ...(candidates ? { candidates: candidateHits } : {}),
  }
}

const main = () => {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.targets.length) {
    console.log('Usage: scan-tracking.mjs <path...> [--root <dir>] [--candidates]')
    process.exit(args.help ? 0 : 1)
  }
  const cfg = getConfig()
  const analytics = cfg.analytics ?? {}
  const patterns = analytics.patterns?.length
    ? analytics.patterns
    : ['\\btrack(?:Event)?\\s*\\(', '\\bcapture\\s*\\(', '\\banalytics\\.\\w+\\s*\\(', '\\blogger\\.event\\s*\\(', '\\breport(?:Event|EventV3)?\\s*\\(']
  const exclude = analytics.exclude ?? ['test', 'spec', 'fixture', 'mock', '__tests__']
  const root = resolve(args.root ?? cfg.repoDir ?? process.cwd())
  try {
    process.stdout.write(JSON.stringify(
      scan(root, args.targets, patterns, exclude, { candidates: args.candidates }), null, 2) + '\n')
  } catch (e) {
    console.error(`scan-tracking: ${e.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith('scan-tracking.mjs')) main()
