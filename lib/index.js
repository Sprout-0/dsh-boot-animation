/**
 * dsh-boot-animation — the host half. Deliberately small.
 *
 * Plain JavaScript with no DSH SDK imports, so it needs no compiler and no DSH source
 * checkout: `scripts/build.sh` copies this file to lib/index.js.
 *
 * It does two things, and nothing else:
 *
 * 1. Serves the one embedded clip on `/dsh-boot-animation/boot.mp4`, with Range
 *    support. A `<video>` element issues range requests, and an element that gets a
 *    200 where it expected a 206 sometimes refuses to play at all.
 *
 * 2. Injects ONE stylesheet into the page, early enough to beat the app's own boot
 *    screen, so a launch shows the clip instead of the "HARNESS / Loading plugins…"
 *    card. The stylesheet is plain CSS with its own expiry — nothing in it depends on a
 *    script running. That is the lesson this file was rewritten around: an earlier
 *    version cleared its cover from an injected `<script>`, the row carried that script
 *    as markup, markup placed with innerHTML never executes, and the harness came up
 *    permanently black. A decoration must not be able to do that.
 *
 * Everything else the upstream plugin carried is gone: the clip library and its routes,
 * `selection.json`, the "drop your own video" scan, the sidebar panel, the fit switch,
 * the per-session launch history, the status endpoint. The whole feature is now:
 *
 *     the window opens → the clip plays → it fades → you are in the workspace
 *
 * Fewer moving parts is the point. Every part that was removed was also a way for a
 * launch to end up black, or for the clip to be cut short.
 *
 * The clip is EMBEDDED IN CODE (`lib/clips.data.js`), not a file on disk: there is no
 * asset to lose, to be filtered out of the package, or to be shipped with the wrong
 * container flags. `lib/clips.meta.js` carries its name and size; the base64 payload is
 * imported LAZILY, so the host does not parse ~2.4MB it may never need.
 */
import { CLIPS } from './clips.meta.js'

export const name = 'dsh-boot-animation'

/** The webserver routes are the only host service this plugin needs. */
export const inject = ['webServer']

const BASE_ROUTE = '/dsh-boot-animation'
const VIDEO_ROUTE = BASE_ROUTE + '/boot.mp4'
/**
 * Launch trace. Diagnostics only — it draws nothing, and nothing reads it except a
 * `curl` when a launch needs explaining. It exists because three rounds of guessing at a
 * black frame were all wrong, and one `curl` of this endpoint was not.
 */
const TRACE_ROUTE = BASE_ROUTE + '/trace.json'
const CONTENT_TYPE = 'video/mp4'

/** The one clip this plugin plays. */
const CLIP = CLIPS[0]

/** Root attribute the injected cover is keyed on; setting it reveals the app. */
const COVER_ATTRIBUTE = 'data-dba-intro-ready'

/** Decoded clip bytes, filled on first request. */
let clipBuffer = null

/**
 * The clip's bytes, decoded once.
 *
 * `lib/clips.data.js` is ~2.4MB of base64. Importing it eagerly would make every DSH
 * start pay for a video it may never serve, so it is imported on the first request and
 * the decoded Buffer is kept afterwards.
 * @returns the clip bytes, or null when the data module is missing or empty.
 */
async function loadClip() {
  if (clipBuffer !== null) return clipBuffer
  const data = await import('./clips.data.js')
  const b64 = data[CLIP.id]
  clipBuffer = typeof b64 === 'string' ? Buffer.from(b64, 'base64') : null
  return clipBuffer
}

/**
 * Serve the clip, honouring Range.
 *
 * `cache-control: no-store` is deliberate. The clip is one fixed asset served over the
 * loopback interface, so re-reading it costs nothing, and a cached media response is one
 * more thing that can hand a `<video>` a spliced file — which does not error, it simply
 * never paints. The clip is fetched once per launch.
 * @param req - the request, read for `Range` and `HEAD`.
 * @param res - the response the bytes are written to.
 * @param buffer - the whole clip.
 */
function sendClip(req, res, buffer) {
  const size = buffer.length
  const headers = {
    'content-type': CONTENT_TYPE,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    etag: '"' + CLIP.sha256 + '"',
  }

  const range = req.headers.range
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match !== null) {
      const rawStart = match[1]
      const rawEnd = match[2]
      let start = rawStart === '' ? undefined : Number(rawStart)
      let end = rawEnd === '' ? undefined : Number(rawEnd)
      if (start === undefined && end !== undefined) {
        // Suffix form: the last N bytes.
        start = Math.max(0, size - end)
        end = size - 1
      }
      if (start !== undefined && end === undefined) end = size - 1
      const valid =
        start !== undefined &&
        end !== undefined &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start <= end &&
        start < size
      if (!valid) {
        res.writeHead(416, { 'content-range': 'bytes */' + String(size), 'cache-control': 'no-store' })
        res.end()
        return
      }
      end = Math.min(end, size - 1)
      res.writeHead(206, {
        ...headers,
        'content-length': String(end - start + 1),
        'content-range': 'bytes ' + String(start) + '-' + String(end) + '/' + String(size),
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      res.end(buffer.subarray(start, end + 1))
      return
    }
  }

  res.writeHead(200, { ...headers, 'content-length': String(size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(buffer)
}

/** Serve `/boot.mp4` — the only video route there is. */
function serveVideo(req, res) {
  void loadClip()
    .then((buffer) => {
      if (buffer === null) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('dsh-boot-animation: the embedded clip is missing from lib/clips.data.js')
        return
      }
      sendClip(req, res, buffer)
    })
    .catch(() => {
      try {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('dsh-boot-animation: could not read the embedded clip')
      } catch {
        /* headers already sent */
      }
    })
}

/** Launch trace: what happened, in what order. See {@link serveTrace}. */
const trace = []
const traceStartedAt = new Date().toISOString()
const TRACE_LIMIT = 100

/**
 * Record one launch event, and answer with everything recorded so far.
 *
 * A black frame between two layers is a timing question — which layer stopped painting
 * before which other layer started — and reading the code cannot settle it. Both halves
 * report here, so `curl .../trace.json` holds the real order after a real launch.
 * @param req - the request; `?e=<event>` appends one event.
 * @param res - the response carrying every recorded event.
 */
function serveTrace(req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')
  const event = url.searchParams.get('e')
  if (event !== null && event !== '') {
    trace.push({ at: new Date().toISOString(), event: event.slice(0, 120) })
    while (trace.length > TRACE_LIMIT) trace.shift()
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({ startedAt: traceStartedAt, now: new Date().toISOString(), events: trace }, null, 2))
}

/**
 * The stylesheet the page gets before it paints.
 *
 * Layer order, bottom to top: official boot card < black stage < the overlay the client
 * half builds. Everything here is CSS, and the stage carries its own expiry as an
 * animation, so the page can never be left behind it.
 */
const BOOT_COVER_CSS =
  // The app's boot card is COVERED, not hidden, and that distinction is the whole design.
  //
  // Hiding it needs a rule that is UNDONE when the intro ends, and the moment that rule is
  // undone a boot card still in the DOM — a hand-over that has not completed yet — appears
  // out of nowhere. That is measured, not reasoned: with the card hidden, the browser probe
  // caught it painting `display:flex` in the same sample that the cover came down.
  //
  // Covering needs no undo. The stand-in below is a black layer at 2147482000, the app's
  // boot card has no stacking context of its own, and the clip's overlay sits above it at
  // 2147483000 — so the card is out of sight for exactly as long as something is on top of
  // it, and what the intro reveals is whatever the app actually has at that moment.
  //
  // The stand-in carries its own expiry as a CSS animation: three seconds is far longer
  // than the overlay needs to appear (measured: 250ms), and short enough that a launch where
  // the client never runs at all falls through to the app's own boot card instead of staying
  // black. Nothing here can fail closed, and nothing here needs a script.
  '@keyframes dba-cover-out{to{opacity:0;visibility:hidden}}' +
  `html:not([${COVER_ATTRIBUTE}])::after{content:'';position:fixed;inset:0;` +
  'z-index:2147482000;background:#000;pointer-events:none;' +
  'animation:dba-cover-out .5s ease 3s forwards}'

/**
 * The index-injection rows that replace the app's own boot screen.
 *
 * Styling only, deliberately: the renderer PLACES these rows rather than executing them,
 * and a `script` row is one more thing that can fail at the worst possible moment.
 */
const BOOT_COVER_ROWS = [{ kind: 'style', text: BOOT_COVER_CSS }]

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.on('webserver/index-inject', (rows) => {
        for (const row of BOOT_COVER_ROWS) rows.push(row)
      }),
    'dsh-boot-animation: boot cover',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: VIDEO_ROUTE, handler: serveVideo }),
    'dsh-boot-animation: the clip',
  )
  ctx.effect(
    () =>
      ctx.webServer.register({ kind: 'prefix', path: TRACE_ROUTE, handler: (req, res) => serveTrace(req, res) }),
    'dsh-boot-animation: launch trace',
  )
}
