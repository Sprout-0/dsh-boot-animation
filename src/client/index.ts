/**
 * @dsh-external/dsh-boot-animation - browser half. One clip, one fade, no controls.
 *
 * The overlay is plain DOM, built and appended to `<body>` the moment `apply()` runs: no UI
 * slot, no React, no service, nothing a re-render can reach. That is the fix for the
 * longest-running bug in this plugin. It used to live in `shell.overlay`, and the app
 * RE-MOUNTS that slot while the boot screen hands over to the real tree. A re-mount either
 * unmounted the overlay — the clip vanished part-way through, which is exactly what "the
 * animation is not complete" looks like — or found whatever "already played" latch lived in
 * render state, suppressed the second mount, and left the launch with no animation at all.
 * The clip was never at fault; its host was.
 *
 * There are no controls. No switch, no on/off preference, no per-conversation rule: the
 * plugin does one thing when the window opens. A sidebar switch used to live here, and
 * removing it removed React, the slot registration, the `localStorage` preference and the
 * whole "off" path with it — every one of those was a way for the launch to end up doing
 * something other than playing the clip.
 *
 * Two things can still end it early, and both exist so a launch can never trap anyone behind
 * a full-frame overlay: the 跳过 button, and a stall watchdog. Neither says anything on
 * screen: the overlay is already black, so text that lives for a few hundred milliseconds
 * reads as a flash rather than as information.
 *
 * Browser policy, honestly: autoplay of a clip with sound needs a user gesture, so the clip
 * starts MUTED. There is no click-to-unmute affordance — this is a launch animation, not a
 * player, and the hint text that once advertised one was the thing that made it look wrong.
 */

/** The clip, served by the host half. Range requests drive this route directly. */
const VIDEO_URL = '/dsh-boot-animation/boot.mp4'
/** Where the host half keeps the launch trace; see `serveTrace` there. */
const TRACE_URL = '/dsh-boot-animation/trace.json'
/**
 * Latch for "the intro already played in this window".
 *
 * `sessionStorage`, not component state: it survives a reload in the same window and dies
 * with it, so its lifetime is exactly "once per launch of the application".
 */
const LAUNCH_KEY = 'dsh-boot-animation:launch'
/** Root attribute the host half's cover is keyed on; setting it reveals the app. */
const COVER_ATTRIBUTE = 'data-dba-intro-ready'
/** Where the overlay's own stylesheet lives, so a second call can find it. */
const STYLE_ID = 'dsh-boot-animation-style'
/** Where the native-caption-band override lives; removed with the overlay. */
const CHROME_STYLE_ID = 'dsh-boot-animation-chrome'

/**
 * Overlay fade-out. The fade is what reveals the interface underneath; cutting straight to
 * it reads as the clip being yanked away.
 */
const FADE_OUT_MS = 500
/** Never let a stalled clip trap the user behind the overlay. */
const STALL_TIMEOUT_MS = 25000

/**
 * True once the intro has been shown in this window.
 * @returns whether {@link markIntroPlayed} has run in this window session.
 */
function hasPlayedThisLaunch(): boolean {
  try {
    return window.sessionStorage.getItem(LAUNCH_KEY) === '1'
  } catch {
    return false
  }
}

/** Latch the launch so a reload in the same window does not replay the intro. */
function markIntroPlayed(): void {
  try {
    window.sessionStorage.setItem(LAUNCH_KEY, '1')
  } catch {
    /* no storage: the intro may replay, which beats never playing at all */
  }
}

/**
 * Report one launch event to the host half.
 *
 * Best effort by design: a trace that could break the intro it describes would be worse
 * than no trace. `trace.json` is what turns "the animation is wrong" into a sequence with
 * timestamps, and this plugin has already spent several rounds proving that reading the
 * code cannot substitute for it.
 * @param event - short label; no payload.
 */
function trace(event: string): void {
  try {
    void fetch(TRACE_URL + '?e=' + encodeURIComponent(event), { method: 'POST', keepalive: true }).catch(() => {})
  } catch {
    /* tracing is best effort */
  }
}

/**
 * The overlay's stylesheet.
 *
 * NOTE: never put a backtick in this block — the whole sheet is a template literal, and one
 * backtick ends it. `scripts/check-css-template.mjs` enforces that.
 */
const CSS = `
.dba-root{position:fixed;inset:0;z-index:2147483000;background:#000;
  overflow:hidden;pointer-events:auto;transition:opacity ${FADE_OUT_MS}ms ease}
/* Applied only while closing: the overlay holds its last frame and fades instead of
   vanishing. Pointer events leave with it, so a click during the fade reaches the
   interface the user is about to use rather than the dying overlay. */
.dba-out{opacity:0;pointer-events:none}
/* The clip fills the window. Cover, not contain: a launch that leaves black bars on a
   normal monitor reads as broken, and this overlay is a splash screen. */
.dba-video{width:100%;height:100%;object-fit:cover;object-position:center;
  background:#000;display:block}
.dba-skip{position:absolute;top:20px;right:22px;z-index:2;
  border:1px solid rgba(255,255,255,.42);background:rgba(0,0,0,.42);
  color:#fff;border-radius:999px;padding:6px 16px;font-size:13px;line-height:1.4;
  font-family:inherit;cursor:pointer}
.dba-skip:hover{background:rgba(0,0,0,.66)}
/* Windows desktop reserves the frame's top band for the native caption buttons
   (minimize / maximize / close). They float ABOVE the page, so a control sitting 20px
   from the top lands under 关闭 and can no longer be clicked. The preload marks Windows
   desktop with data-windows-titlebar, and the frame publishes the band below the caption
   row as --dsh-frame-overlay-top (titlebar height + 20px; 20px again in native
   fullscreen). Plain web documents carry neither, so the corner placement stays as it is
   there. */
html[data-windows-titlebar] .dba-skip{top:var(--dsh-frame-overlay-top,60px)}
`

/** The rule that folds the native caption band into the animation. */
const CHROME_CSS =
  'html,body{--dsw-specific-sidebar-fill:transparent !important;--dsw-alias-label-primary:#f5f5f7 !important}'

/** Add the overlay's stylesheet, once. */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/**
 * Whether the Desktop shell reserves a native caption row above the page.
 *
 * The Windows preload marks `<html>` with `data-windows-titlebar`. Ordinary Web documents
 * never carry the mark, which is what keeps this whole path inert in a browser — there the
 * caption band does not exist and the sidebar fill is still on screen behind the overlay.
 * @returns true only inside the Windows Electron shell.
 */
function hasNativeCaptionRow(): boolean {
  return document.documentElement.hasAttribute('data-windows-titlebar')
}

/**
 * Fold the native caption band into the animation for as long as it is on screen.
 *
 * Minimize / maximize / close are drawn by the system ABOVE the page, on a background the
 * Desktop shell samples from the live theme: `preload-windows.js` keeps a hidden probe
 * styled `background-color: var(--dsw-specific-sidebar-fill)` and
 * `color: var(--dsw-alias-label-primary)`, and mirrors both onto the real window over
 * `setTitleBarOverlay`. It re-samples whenever `<head>` mutates.
 *
 * A full-frame clip therefore leaves one light rectangle in the corner — the light-theme
 * sidebar fill sitting on top of a black animation. Overriding the two variables for the
 * duration and removing the sheet on close drives the band to `transparent`, so the clip
 * runs edge to edge.
 *
 * `body` is the part that matters: DSH declares both tokens on `body` — light in
 * `body{…}`, dark in `body[data-ds-dark-theme]{…}` — and the probe the preload samples is
 * appended to `body`. A rule that only targeted `html` is shadowed by body's own
 * declaration, probe included, and the band never changes colour. `html` stays in the
 * selector so the rule still holds if a build moves the tokens up.
 * @returns the disposer that restores the user's own theme colours.
 */
function applyCaptionBandOverride(): () => void {
  if (!hasNativeCaptionRow()) return () => {}
  const previous = document.getElementById(CHROME_STYLE_ID)
  if (previous !== null) previous.remove()
  const style = document.createElement('style')
  style.id = CHROME_STYLE_ID
  style.textContent = CHROME_CSS
  document.head.appendChild(style)
  return () => style.remove()
}

/**
 * Release the launch to the app.
 *
 * One attribute does both jobs, because the host half keys both rules on it: it removes the
 * black stand-in AND un-hides the app's own boot card. So this is called when the clip has
 * faded — and it is the only exit, which is the point.
 */
function dropBootCover(): void {
  document.documentElement.setAttribute(COVER_ATTRIBUTE, '')
}

/**
 * Build the overlay, play the clip, and take the whole thing down again.
 *
 * Everything here is a local of this call: the elements, the timers and the disposers are
 * owned by one function invocation, so there is no state a re-render could reach into.
 */
function run(): void {
  const body = document.body
  if (body === null) return

  ensureStyle()
  const disposeChrome = applyCaptionBandOverride()

  const root = document.createElement('div')
  root.className = 'dba-root'

  const video = document.createElement('video')
  video.className = 'dba-video'
  video.src = VIDEO_URL
  video.muted = true
  video.autoplay = true
  video.playsInline = true
  video.preload = 'auto'
  root.appendChild(video)

  const skip = document.createElement('button')
  skip.type = 'button'
  skip.className = 'dba-skip'
  skip.textContent = '跳过'
  root.appendChild(skip)

  let finished = false
  let guard = 0

  /**
   * End the animation: fade the overlay, then remove it.
   *
   * Every exit lands here — the clip ending, 跳过, a stall, a media error — so the guard is
   * what keeps a second one from stacking a second fade behind the first.
   */
  const finish = (): void => {
    if (finished) return
    finished = true
    window.clearTimeout(guard)
    try {
      video.pause()
    } catch {
      /* already stopped */
    }
    root.classList.add('dba-out')
    // The host half's cover comes down only now: what is behind the overlay is finally the
    // thing that should be on screen. Taking it down at the start would uncover the page
    // while the clip was still starting, which is the white flash this plugin already
    // fixed once.
    dropBootCover()
    trace('cover-off')
    window.setTimeout(() => {
      root.remove()
      // The caption band belongs to the animation, not to the workspace: leaving the
      // override in place would leave the user's title bar transparent forever.
      disposeChrome()
      trace('overlay-removed')
    }, FADE_OUT_MS)
  }

  skip.addEventListener('click', () => {
    trace('skip:clicked')
    finish()
  })
  video.addEventListener('ended', () => {
    trace('clip:ended')
    finish()
  })
  video.addEventListener('playing', () => {
    trace('clip:playing')
  })
  video.addEventListener('error', () => {
    // Reported before finishing: a silent close leaves nothing to diagnose. Nothing is
    // shown on screen — the overlay goes away instead, which is the whole fix.
    trace('clip:error')
    finish()
  })

  guard = window.setTimeout(() => {
    trace('clip:stalled')
    finish()
  }, STALL_TIMEOUT_MS)

  body.appendChild(root)
  trace('overlay-mounted')

  // Explicitly started rather than left to the autoplay attribute: a rejected play() has to
  // be visible in the trace, and relying on the attribute alone is fragile.
  const attempt = video.play()
  if (attempt !== undefined && typeof attempt.catch === 'function') {
    attempt.catch(() => {
      trace('clip:play-rejected')
      finish()
    })
  }
}

/** Guards against a second `start` in the same module instance. */
let started = false

/**
 * Mount the intro, unless this window has already shown it.
 *
 * Nothing here waits for a service, so it cannot be held pending by a missing dependency and
 * cannot be re-run by a re-mount: a decoration must never be able to cost someone their
 * harness, and neither must its teardown.
 */
function start(): void {
  if (started) return
  started = true
  ensureStyle()

  if (hasPlayedThisLaunch()) {
    trace('launch:already-played')
    return
  }

  markIntroPlayed()
  trace('launch:start')

  if (document.body === null) {
    document.addEventListener('DOMContentLoaded', run, { once: true })
    return
  }
  run()
}

/**
 * The whole client half.
 *
 * No static `inject` and no UI slot, deliberately. A static dependency the host cannot
 * satisfy leaves this plugin's fiber PENDING forever, and the web boot treats ANY entry that
 * is not `active` as fatal: `web boot: N entry did not activate`, with no GUI at all. And a
 * slot can be re-mounted underneath the overlay. Asking for nothing avoids both.
 * @param _ctx - the client context, deliberately unused.
 */
export function apply(_ctx?: unknown): void {
  start()
}
