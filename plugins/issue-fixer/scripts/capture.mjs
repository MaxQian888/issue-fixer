// before/after screenshot helpers — repo-agnostic.
//
// Two responsibilities:
//  1) screenshotUrl(url, out)  — drive a real browser to a route and snap a PNG.
//     Resolves playwright from the target repo (FIXER_REPO_DIR, then
//     capture.playwrightDirs / repo packages), so no extra install. If the agent prefers,
//     it can use a Playwright MCP instead — the SKILL documents both; this script is the
//     deterministic path.
//  2) composeCompare(before, after, outHtml) — a dependency-free side-by-side compare
//     page (both PNGs inlined as data URIs). Viewable anywhere; can itself be screenshotted.
//
// Auth is fully config-driven (capture.* / FIXER_*):
//   --auth           resolve a token from the env vars in capture.authTokenVars, else
//                    run capture.authTokenCommand (e.g. an internal SSO/JWT CLI); send it
//                    as header capture.authHeader (default x-jwt-token). If
//                    capture.authInitScript is a JS file path, its content runs as a
//                    page init script receiving `token` (e.g. seed localStorage).
//   --jwt <token>    explicit token, skips resolution.
//   --env <lane>     real-env routing: expands capture.envHeaders (FIXER_ENV_HEADERS)
//                    templates, e.g. {"x-env":"{env}","x-preview":"1"}.
//
// CLI:
//   node capture.mjs shot <url> <out.png> [--width 1440 --height 900 --wait 3000] [--auth|--jwt t] [--env lane] [--header k:v] [--wait-selector s] [--storage s] [--full]
//   node capture.mjs compare <before.png> <after.png> <out.html> [label]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { getConfig } from './lib/config.mjs'

const isJwt = (v) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test((v || '').trim())

/**
 * Resolve an auth token the generic way: env-injected first (from capture.authTokenVars),
 * else capture.authTokenCommand stdout. Works in an isolated agent run / CI without any
 * browser login. Returns null when nothing is configured.
 */
export function resolveAuthToken(cfg) {
  for (const name of cfg.capture.authTokenVars || []) {
    const v = process.env[name]
    if (v && v.trim()) return v.trim()
  }
  const cmd = cfg.capture.authTokenCommand
  if (cmd) {
    const token = execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
    if (!token) throw new Error(`capture.authTokenCommand produced no token: ${cmd}`)
    return token
  }
  throw new Error('no auth token env var set and capture.authTokenCommand not configured')
}

function packageDirs(repoDir) {
  const dirs = [repoDir]
  for (const parent of ['packages', 'apps', 'services']) {
    const abs = path.join(repoDir, parent)
    if (!existsSync(abs)) continue
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(abs, entry.name, 'package.json'))) {
        dirs.push(path.join(abs, entry.name))
      }
    }
  }
  return dirs
}

async function loadPlaywright(cfg) {
  // Reuse the target repo's installed Playwright: capture.playwrightDirs first, then the
  // repo root and its package dirs. Some checkouts ship playwright, @playwright/test, or
  // playwright-core — try each.
  const bases = [
    ...(cfg.capture.playwrightDirs || []),
    ...(cfg.repoDir ? packageDirs(cfg.repoDir) : []),
  ]
  const pkgs = ['playwright', '@playwright/test', 'playwright-core']
  for (const base of bases) {
    let require
    try {
      require = createRequire(path.join(base, 'package.json'))
    } catch {
      continue
    }
    for (const pkg of pkgs) {
      try {
        const mod = await import(require.resolve(pkg))
        const pw = mod.chromium ? mod : mod.default // CJS (@playwright/test) puts chromium on default
        if (pw?.chromium) return pw
      } catch {
        /* try next */
      }
    }
  }
  try {
    const mod = await import('@playwright/test')
    const pw = mod.chromium ? mod : mod.default
    if (pw?.chromium) return pw
  } catch {
    /* fall through */
  }
  throw new Error(
    `playwright not resolvable from ${cfg.repoDir || '(no FIXER_REPO_DIR)'}. Install @playwright/test ` +
      '(or playwright) in the target repo, or set capture.playwrightDirs / use a Playwright MCP instead.',
  )
}

export async function screenshotUrl(url, out, opt = {}) {
  const cfg = opt.cfg || getConfig()
  const { width = 1440, height = 900, wait = 3000, fullPage = false, storageState, authWallSelector, extraHTTPHeaders, auth } = opt
  const token = auth ? (typeof auth === 'string' ? auth : resolveAuthToken(cfg)) : null
  const headers = {
    ...(extraHTTPHeaders || {}),
    ...(token ? { [cfg.capture.authHeader || 'x-jwt-token']: token } : {}),
  }
  const pw = await loadPlaywright(cfg)
  let browser
  try {
    browser = await pw.chromium.launch({ headless: true })
  } catch (e) {
    throw new Error(
      `Chromium launch failed: ${e.message}. Install browsers once with \`npx playwright install chromium\` ` +
        `from the repo that provides playwright.`,
    )
  }
  try {
    const ctx = await browser.newContext({
      viewport: { width, height },
      storageState: storageState || undefined,
      extraHTTPHeaders: Object.keys(headers).length ? headers : undefined,
    })
    const page = await ctx.newPage()
    if (token && cfg.capture.authInitScript) {
      // The configured init script receives `token` and seeds whatever storage the app
      // expects BEFORE app scripts run (cookie/localStorage conventions differ per app).
      const body = readFileSync(cfg.capture.authInitScript, 'utf8')
      await page.addInitScript(new Function('token', body), token)
    }
    let navError = null
    let status = null
    // SPAs with persistent connections never reach 'networkidle' — use domcontentloaded + an
    // explicit render wait, and optionally wait for a content selector.
    const resp = await page.goto(url, { waitUntil: opt.waitUntil || 'domcontentloaded', timeout: 45000 }).catch((e) => {
      navError = e.message
      return null
    })
    if (resp && typeof resp.status === 'function') status = resp.status()
    let expectedSelectorFound = null
    if (opt.waitForSelector) {
      expectedSelectorFound = await page
        .waitForSelector(opt.waitForSelector, { timeout: 30000 })
        .then(() => true)
        .catch(() => false)
    }
    if (wait) await page.waitForTimeout(wait)
    const finalUrl = page.url()
    // Detect an auth wall / onboarding redirect so the caller can fall back (component-isolation).
    const authWall =
      /login|passport|sso|\/oauth|unauthor|\/landing/i.test(finalUrl) ||
      (authWallSelector ? (await page.$(authWallSelector)) != null : false)
    await page.screenshot({ path: out, fullPage })
    return {
      url,
      finalUrl,
      out,
      title: await page.title().catch(() => ''),
      status,
      navError,
      authWall,
      expectedSelector: opt.waitForSelector || null,
      expectedSelectorFound,
    }
  } finally {
    await browser.close()
  }
}

const dataUri = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`

export function composeCompare(beforePng, afterPng, outHtml, label = '') {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>before / after</title>
<style>
  body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#0b0d12;color:#e6e8ee}
  h1{font-size:15px;padding:14px 18px;margin:0;border-bottom:1px solid #232838}
  .row{display:flex;gap:0;align-items:flex-start}
  .col{flex:1;min-width:0;padding:14px}
  .col+.col{border-left:1px solid #232838}
  .tag{display:inline-block;font-weight:600;padding:2px 10px;border-radius:99px;margin-bottom:10px}
  .before .tag{background:#3a1d24;color:#ff9db1}.after .tag{background:#173a27;color:#7ee2a8}
  img{max-width:100%;border:1px solid #232838;border-radius:8px;display:block}
</style></head><body>
<h1>issue-fixer · before / after${label ? ' · ' + label : ''}</h1>
<div class="row">
  <div class="col before"><span class="tag">BEFORE（改前）</span><img src="${dataUri(beforePng)}"></div>
  <div class="col after"><span class="tag">AFTER（改后）</span><img src="${dataUri(afterPng)}"></div>
</div></body></html>`
  writeFileSync(outHtml, html)
  return outHtml
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const [cmd, ...a] = process.argv.slice(2)
  const flag = (n, d) => {
    const i = a.indexOf(`--${n}`)
    return i >= 0 ? a[i + 1] : d
  }
  const headers = () => {
    const h = {}
    a.forEach((x, i) => {
      if (x === '--header' && a[i + 1]) {
        const kv = a[i + 1]
        const idx = kv.search(/[:=]/)
        if (idx > 0) h[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim()
      }
    })
    const env = flag('env')
    if (env) {
      const tpl = getConfig().capture.envHeaders || {}
      if (!Object.keys(tpl).length) {
        throw new Error('--env requires capture.envHeaders (FIXER_ENV_HEADERS), e.g. {"x-env":"{env}","x-preview":"1"}')
      }
      for (const [k, v] of Object.entries(tpl)) h[k] = String(v).replaceAll('{env}', env)
    }
    return Object.keys(h).length ? h : undefined
  }
  const run = async () => {
    if (cmd === 'shot') {
      const r = await screenshotUrl(a[0], a[1], {
        width: +flag('width', 1440),
        height: +flag('height', 900),
        wait: +flag('wait', 3000),
        fullPage: a.includes('--full'),
        storageState: flag('storage'),
        extraHTTPHeaders: headers(),
        auth: flag('jwt') || (a.includes('--auth') ? true : undefined), // --jwt <token> | --auth (resolve via env/command)
        waitForSelector: flag('wait-selector'),
      })
      console.log(JSON.stringify(r))
    } else if (cmd === 'compare') {
      console.log(composeCompare(a[0], a[1], a[2], a[3] || ''))
    } else {
      console.error('usage: capture.mjs shot <url> <out.png> [--env <lane>] [--auth|--jwt <t>] [--storage <s>] [--header k:v] | compare <before> <after> <out.html> [label]')
      process.exit(2)
    }
  }
  run().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
