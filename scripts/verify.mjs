/**
 * verify.mjs — what this plugin must be, checked against what it actually ships.
 *
 * Two halves, two questions:
 *
 *   - the HOST registers exactly two routes plus one injected stylesheet, and the clip
 *     route answers a real Range request with real bytes;
 *   - the CLIENT bundle plays one clip, starting at the launch, WITHOUT React and WITHOUT
 *     a UI slot.
 *
 * Half of these checks are "must NOT contain", and that is the important half. Everything
 * asserted absent here was removed for a reason — a slot that gets re-mounted mid-clip, a
 * per-conversation play history, a clip library, a script-cleared cover. A silent
 * re-introduction of any of them is exactly the kind of change that costs a launch, and a
 * test that only counted the good things would not notice.
 *
 * Run: node scripts/verify.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIPS } from '../lib/clips.meta.js'
import { apply, inject, name } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const CLIP = CLIPS[0]

let failures = 0
/** @param ok - the condition; @param label - what it means. */
function check(ok, label, detail = '') {
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail === '' ? '' : '   -> ' + detail))
  if (!ok) failures += 1
}

function section(title) {
  console.log('\n' + title + ':')
}

// ---------------------------------------------------------------------------
// The host half, driven through its own `apply`.
// ---------------------------------------------------------------------------

const routes = []
const listeners = []
const ctx = {
  effect: (cb) => {
    cb()
    return () => {}
  },
  on: (event, cb) => {
    listeners.push({ event, cb })
    return () => {}
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  },
}

apply(ctx)

section('host: what it registers')
check(name === 'dsh-boot-animation', 'the plugin name is unchanged', name)
check(
  Array.isArray(inject) && inject.length === 1 && inject[0] === 'webServer',
  'asks for the web server and nothing else',
  JSON.stringify(inject),
)
check(routes.length === 2, 'registers exactly two routes', routes.map((r) => r.path).join(', '))
check(
  routes.some((r) => r.path === '/dsh-boot-animation/boot.mp4'),
  'serves the clip',
)
check(
  routes.some((r) => r.path === '/dsh-boot-animation/trace.json'),
  'serves the launch trace',
)
check(
  routes.every((r) => r.kind === 'prefix'),
  'every route is a prefix route',
)
check(
  listeners.some((l) => l.event === 'webserver/index-inject'),
  'injects into the page before it paints',
)

section('host: the injected stylesheet')
const rows = []
const injector = listeners.find((l) => l.event === 'webserver/index-inject')
injector.cb(rows)
check(rows.length === 1 && rows[0].kind === 'style', 'exactly one row, and it is a stylesheet', rows.map((r) => r.kind).join(', '))
const css = rows[0]?.text ?? ''
check(
  !css.includes('[data-dsh-boot]'),
  'the boot card is COVERED, never hidden',
  'a hidden card has to be un-hidden, and the probe caught that flash',
)
check(
  css.includes('@keyframes dba-cover-out') && css.includes('animation:dba-cover-out'),
  'the cover expires by itself, with no script to run',
)
check(css.includes('z-index:2147482000'), 'the cover sits BELOW the clip overlay (2147483000)')
check(css.includes('pointer-events:none'), 'the cover never swallows clicks')

section('host: the clip route')
/** Drive one request through a handler and resolve when it ends. */
function request(handler, { method = 'GET', url = '/dsh-boot-animation/boot.mp4', headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      headers: {},
      body: null,
      writeHead(status, sent) {
        this.status = status
        this.headers = sent ?? {}
      },
      end(body) {
        if (body !== undefined) this.body = body
        resolve(this)
      },
    }
    handler({ method, url, headers }, res)
  })
}

const clipRoute = routes.find((r) => r.path === '/dsh-boot-animation/boot.mp4')
const whole = await request(clipRoute.handler)
check(whole.status === 200, 'a bare GET answers 200', String(whole.status))
check(whole.body?.length === CLIP.bytes, 'and the whole clip', `${whole.body?.length} of ${CLIP.bytes} bytes`)
check(whole.headers['content-type'] === 'video/mp4', 'with the video content type')
check(whole.headers['accept-ranges'] === 'bytes', 'and advertises Range support')

const ranged = await request(clipRoute.handler, { headers: { range: 'bytes=0-99' } })
check(ranged.status === 206, 'a Range request answers 206', String(ranged.status))
check(ranged.body?.length === 100, 'with exactly the requested window', String(ranged.body?.length))
check(
  ranged.headers['content-range'] === `bytes 0-99/${CLIP.bytes}`,
  'and a correct content-range',
  ranged.headers['content-range'],
)

const bad = await request(clipRoute.handler, { headers: { range: 'bytes=999999999-' } })
check(bad.status === 416, 'an unsatisfiable Range answers 416', String(bad.status))

const head = await request(clipRoute.handler, { method: 'HEAD' })
check(head.status === 200 && head.body === null, 'HEAD answers headers and no body')

const traceRoute = routes.find((r) => r.path === '/dsh-boot-animation/trace.json')
const traced = await request(traceRoute.handler, { url: '/dsh-boot-animation/trace.json?e=verify' })
check(traced.status === 200, 'the trace route answers 200', String(traced.status))
check(
  JSON.parse(traced.body.toString('utf8')).events.some((e) => e.event === 'verify'),
  'and records the event it was given',
)

// ---------------------------------------------------------------------------
// The client bundle, read as text.
// ---------------------------------------------------------------------------

const bundle = readFileSync(join(PKG, 'lib', 'client.js'), 'utf8')
const hostText = readFileSync(join(PKG, 'lib', 'index.js'), 'utf8')

section('client: the one thing it does')
check(bundle.includes('.dba-root'), 'builds an overlay')
check(bundle.includes('/dsh-boot-animation/boot.mp4'), 'plays the clip route')
check(bundle.includes("video.play()"), 'starts playback explicitly')
check(bundle.includes('sessionStorage'), 'latches the launch once per window')
check(bundle.includes('data-dba-intro-ready'), 'takes the host cover down when it is done')
check(bundle.includes('dba-out'), 'fades out instead of vanishing')
check(bundle.includes('跳过') && bundle.includes('dba-skip'), 'keeps an escape hatch')
check(bundle.includes('STALL_TIMEOUT_MS'), 'keeps the stall watchdog')
check(bundle.includes('data-windows-titlebar'), 'moves the escape hatch clear of the native caption row')
check(bundle.includes('--dsw-specific-sidebar-fill'), 'folds the caption band into the animation')

section('client: what must NOT come back')
// Matched against CODE, not prose: this file's own comments explain why each of these was
// removed, so a bare word search would match the explanation of the fix. The names below
// are call sites and string literals, and cannot appear in an English sentence.
check(
  !bundle.includes("'shell.overlay'"),
  'the OVERLAY never returns to a UI slot',
  'a re-mounted slot is what cut the clip short',
)
// The controls that used to live here. Each is asserted absent by identifier, so a rewrite
// cannot quietly bring one back: a switch needs a slot, a slot needs React, and a
// preference needs an "off" path where the launch does nothing.
check(!bundle.includes('slots.register') && !bundle.includes('slots.inject'), 'registers nothing at all — no slot, no seat')
check(!bundle.includes('sidebar.footer.action'), 'no sidebar switch')
check(!bundle.includes('dsh-boot-animation:enabled'), 'no on/off preference')
check(!bundle.includes('launch:disabled'), 'and no "off" path')
check(!bundle.includes('dba-toggle'), 'no button styling')
check(!bundle.includes('react'), 'no React')
check(!bundle.includes('isNewConversation'), 'no per-conversation rules')
check(!bundle.includes('dsh-boot-animation:seen'), 'no per-conversation play history')
check(!bundle.includes('dba-veil') && !bundle.includes('dba-lib'), 'no clip library panel')
check(!bundle.includes('dba-status') && !bundle.includes('dba-hint'), 'nothing prints text over the clip')

section('host: what must NOT come back')
check(!hostText.includes('readSelection') && !hostText.includes('writeSelection'), 'no selection file')
check(!hostText.includes('listVideos') && !hostText.includes('resolveActive'), 'no clip resolution: there is exactly one clip')
check(!hostText.includes('videos.json'), 'no clip listing route')
check(!hostText.includes('boot-animation/videos'), 'no drop-in scan')
check(!hostText.includes('createReadStream'), 'no disk media path at all: the clip is embedded')
check(!/kind:\s*'script'/.test(hostText), 'no injected script row anywhere', 'markup placed by the renderer never executes it')

console.log('')
if (failures === 0) {
  console.log('all checks passed')
} else {
  console.log(failures + ' check(s) FAILED')
  process.exitCode = 1
}
