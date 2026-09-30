/**
 * verify-boot-browser.mjs — drive the real client bundle in a real browser.
 *
 * `scripts/verify.mjs` proves what the two halves SAY. This proves what they DO, in a layout
 * engine, with a real `<video>` element and the real host stylesheet: the overlay appears,
 * the app's own boot card stays out of sight behind it, the clip plays end to end, the
 * overlay fades, and it is removed.
 *
 * One round, because there is exactly one behaviour. There used to be a second round for the
 * sidebar switch's "off" position; the switch is gone, so a second round would assert
 * nothing. The absence of the switch is checked statically, in `verify.mjs`.
 *
 * It is a self-contained loop — no CDP client, no browser driver:
 *
 *   1. a loopback HTTP server serves a page, the built `lib/client.js`, the embedded clip
 *      bytes (with Range support, exactly like the host half) and a trace sink;
 *   2. the page loads the bundle through the same `window.__ModuleLoader__` contract DSH
 *      uses, calls `apply()`, and samples the DOM for a few seconds;
 *   3. the page posts what it saw back to the server;
 *   4. the server prints it and decides.
 *
 * Two things are deliberately hostile, because a probe that is easy on the code under test
 * cannot notice when the code starts needing something:
 *
 *   - the module factory is handed a `require` that THROWS. The overlay must not need any
 *     module at all, and if that ever changes, this fails instead of quietly working in the
 *     one environment that happens to provide it;
 *   - `apply` is called with NO context. DSH passes one; the animation must not care.
 *
 * The host stylesheet is not retyped here: it is taken from `lib/index.js` by driving its
 * real `apply` with the same `webserver/index-inject` seam DSH uses, so the thing measured is
 * the thing shipped.
 *
 * Run: node scripts/verify-boot-browser.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIPS } from '../lib/clips.meta.js'
import { apply as applyHost } from '../lib/index.js'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_MS = 9000
const REPORT_TIMEOUT_MS = 25000

/** Where the clip bytes come from — the same module the host half imports lazily. */
const clipData = await import('../lib/clips.data.js')
const clipBytes = Buffer.from(clipData[CLIPS[0].id], 'base64')
const clientBundle = readFileSync(join(PKG, 'lib', 'client.js'))

/**
 * The stylesheet the host half injects, recovered by calling its real `apply`.
 *
 * Anything else here would be measuring a copy of the CSS rather than the CSS, which is how
 * a probe stops noticing the bug it was written for.
 * @returns the injected stylesheet text.
 */
function hostStylesheet() {
  let injector = null
  const ctx = {
    effect: (cb) => {
      cb()
      return () => {}
    },
    on: (event, cb) => {
      if (event === 'webserver/index-inject') injector = cb
      return () => {}
    },
    webServer: { register: () => () => {} },
  }
  applyHost(ctx)
  const rows = []
  injector?.(rows)
  return rows.find((row) => row.kind === 'style')?.text ?? ''
}

const hostCss = hostStylesheet()
if (hostCss === '') {
  console.error('verify-boot-browser: the host half injected no stylesheet')
  process.exit(1)
}

/** The probe page: the host's own CSS, a stand-in for the app's boot card, and the real bundle. */
const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>boot animation probe</title>
<style>${hostCss}</style>
<style>
  /* The app's boot card, as the web boot builds it, so the host rules have something real to
     act on: it must end up out of sight behind the cover and the overlay. */
  [data-dsh-boot]{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
    font:600 14px system-ui;letter-spacing:.3em;color:#8a8f98;background:#f9fafb}
  body{margin:0;background:#f9fafb}
  /* The interface that should be reachable after the fade. */
  #workspace{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
    font:600 13px system-ui;color:#111}
</style>
</head>
<body>
<div data-dsh-boot>HARNESS</div>
<div id="workspace">WORKSPACE</div>
<script>
  // Each round starts from a clean window; the latch is per-window.
  try { sessionStorage.clear() } catch (error) { /* storage denied: the round still runs */ }

  // The same module contract DSH's loader uses. The factory's \`require\` THROWS on purpose:
  // the overlay must not need any module, and this is what makes that a measured fact.
  window.__ModuleLoader__ = {
    load(spec) {
      window.__plugin = spec.factory(function (name) { throw new Error('the client half required ' + name) })
    },
  }
</script>
<script src="/client.js"></script>
<script>
  const samples = []
  const t0 = performance.now()
  const el = (sel) => document.querySelector(sel)
  const report = (payload) => fetch('/report', { method: 'POST', body: JSON.stringify(payload) })

  try {
    if (window.__plugin === undefined || typeof window.__plugin.apply !== 'function') {
      report({ fatal: 'the bundle registered no apply()', keys: Object.keys(window.__plugin ?? {}) })
    } else {
      // No context at all: the animation must not care, and the switch that once needed one
      // is gone.
      window.__plugin.apply()
    }
  } catch (error) {
    report({ fatal: 'apply() threw: ' + String(error) })
  }

  const timer = setInterval(() => {
    const root = el('.dba-root')
    const video = el('.dba-video')
    const card = el('[data-dsh-boot]')
    samples.push({
      ms: Math.round(performance.now() - t0),
      overlay: root !== null,
      fading: root === null ? null : root.classList.contains('dba-out'),
      overlayZ: root === null ? null : getComputedStyle(root).zIndex,
      cardZ: card === null ? null : getComputedStyle(card).zIndex,
      readyState: video === null ? -1 : video.readyState,
      currentTime: video === null ? -1 : Number(video.currentTime.toFixed(2)),
      paused: video === null ? null : video.paused,
      cover: getComputedStyle(document.documentElement, '::after').content,
      coverVisibility: getComputedStyle(document.documentElement, '::after').visibility,
      coverAttr: document.documentElement.hasAttribute('data-dba-intro-ready'),
    })
  }, 250)

  setTimeout(() => {
    clearInterval(timer)
    const root = el('.dba-root')
    report({ samples, finalOverlay: root !== null })
  }, ${SAMPLE_MS})
</script>
</body>
</html>`

/** First Edge (or Chrome) that exists. */
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
const browserPath = BROWSERS.find((candidate) => existsSync(candidate))
if (browserPath === undefined) {
  console.error('verify-boot-browser: no Edge or Chrome found')
  process.exit(1)
}

const requestLog = []
let settle = null
const reported = new Promise((resolve) => {
  settle = resolve
})

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname

  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
    return
  }
  if (path === '/client.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(clientBundle)
    return
  }
  if (path === '/report') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = { fatal: 'unparsable report: ' + body.slice(0, 200) }
      }
      res.writeHead(204)
      res.end()
      settle(parsed)
    })
    return
  }
  if (path === '/dsh-boot-animation/trace.json') {
    const event = url.searchParams.get('e')
    if (event !== null) requestLog.push({ kind: 'trace', event })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end('{"events":[]}')
    return
  }
  if (path === '/dsh-boot-animation/boot.mp4') {
    const size = clipBytes.length
    const range = req.headers.range
    requestLog.push({ kind: 'media', range: range ?? null })
    if (typeof range === 'string') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (match !== null) {
        let start = match[1] === '' ? undefined : Number(match[1])
        let end = match[2] === '' ? undefined : Number(match[2])
        if (start === undefined && end !== undefined) {
          start = Math.max(0, size - end)
          end = size - 1
        }
        if (start !== undefined && end === undefined) end = size - 1
        if (start !== undefined && end !== undefined && start <= end && start < size) {
          end = Math.min(end, size - 1)
          res.writeHead(206, {
            'content-type': 'video/mp4',
            'accept-ranges': 'bytes',
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${size}`,
            'cache-control': 'no-store',
          })
          res.end(clipBytes.subarray(start, end + 1))
          return
        }
      }
      res.writeHead(416, { 'content-range': 'bytes */' + size, 'cache-control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': String(size),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    })
    res.end(clipBytes)
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const profile = mkdtempSync(join(tmpdir(), 'dba-probe-'))

console.log('browser : ' + browserPath)
console.log('page    : http://127.0.0.1:' + port + '/')

const child = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir=' + profile,
    `http://127.0.0.1:${port}/`,
  ],
  { stdio: 'ignore' },
)

const timeout = new Promise((resolve) =>
  setTimeout(() => resolve({ fatal: 'the page never reported back' }), REPORT_TIMEOUT_MS),
)
const report = await Promise.race([reported, timeout])

try {
  child.kill()
} catch {
  /* already gone */
}
server.close()
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  /* the browser may still hold a handle; a temp directory is not worth failing over */
}

// ---------------------------------------------------------------------------
// What the page saw, in order, and what it means.
// ---------------------------------------------------------------------------

let failures = 0
/** @param ok - the condition; @param label - what it means. */
function check(ok, label, detail = '') {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail === '' ? '' : '   -> ' + detail))
  if (!ok) failures += 1
}

if (report.fatal !== undefined) {
  console.log('\nthe page could not run the probe: ' + report.fatal)
  process.exit(1)
}

const samples = report.samples ?? []
const events = requestLog.filter((r) => r.kind === 'trace').map((r) => r.event)
const ranges = requestLog.filter((r) => r.kind === 'media' && typeof r.range === 'string')
const last = samples[samples.length - 1] ?? {}
const maxTime = Math.max(...samples.map((s) => s.currentTime))

console.log('\nsamples (every 250ms):')
for (const s of samples) {
  console.log(
    `  ${String(s.ms).padStart(5)}ms  overlay=${s.overlay ? 'yes' : 'no '} fading=${s.fading === null ? '-' : s.fading ? 'yes' : 'no '}` +
      `  t=${s.currentTime}s ready=${s.readyState} paused=${s.paused}  z=${s.overlayZ}  cover=${s.cover}  coverAttr=${s.coverAttr}`,
  )
}
console.log('  trace: ' + (events.join(' -> ') || '(none)'))

console.log('\nbehaviour:')
check(events.includes('launch:start'), 'the launcher ran on load')
check(events.includes('overlay-mounted'), 'the overlay was mounted')
check(samples.some((s) => s.overlay), 'the overlay was in the DOM')
check(samples.some((s) => s.currentTime > 0), 'the clip actually advanced')
check(events.includes('clip:playing'), 'the first frame was painted')
check(events.includes('clip:ended'), 'the clip ran to the end')
check(maxTime > 7, 'and the whole clip was seen', 'max t=' + String(maxTime) + 's')
check(ranges.length > 0, 'the clip was fetched with Range requests', String(ranges.length))

console.log('\nlayering (the boot card must never show through):')
check(
  samples.some((s) => s.cover !== 'none'),
  'the host cover was up while the overlay was still starting',
)
check(
  samples.filter((s) => s.overlay).every((s) => s.overlayZ === '2147483000'),
  'the overlay sits at the top of the stack',
  'overlay z=' + String(last.overlayZ),
)
check(
  samples.filter((s) => s.overlay && s.cardZ !== null).every((s) => s.cardZ === 'auto'),
  'and the card has no stacking context of its own to escape with',
  'card z=' + String(last.cardZ),
)

console.log('\nexit:')
check(samples.some((s) => s.fading === true), 'the overlay faded rather than vanishing')
check(report.finalOverlay === false, 'and was removed afterwards', 'still in the DOM: ' + String(report.finalOverlay))
check(last.coverAttr === true, 'the host cover was taken down', 'data-dba-intro-ready=' + String(last.coverAttr))
check(last.cover === 'none', 'and is gone entirely', 'content=' + String(last.cover))

console.log('')
if (failures === 0) {
  console.log('all browser checks passed')
} else {
  console.log(failures + ' browser check(s) FAILED')
  process.exitCode = 1
}
