/**
 * Keep the phone's screen on while JARVIS is open.
 *
 * When an iPhone's screen locks, the page is suspended: the microphone is
 * closed, sound stops and the connection to the bridge drops. A screen wake
 * lock (Safari 16.4+, Chrome) stops the screen locking while the page is in
 * front. The browser releases it whenever the page is hidden, so it is asked
 * for again each time the page comes back.
 */

type Sentinel = { released: boolean; release: () => Promise<void> }
let sentinel: Sentinel | null = null
let wanted = false

async function request() {
  const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } })
    .wakeLock
  if (!wl || document.visibilityState !== 'visible') return
  if (sentinel && !sentinel.released) return
  try {
    sentinel = await wl.request('screen')
  } catch {
    /* refused (low battery mode, or no tap yet) — the page still works */
  }
}

/** Ask for the screen to stay on, and keep asking whenever the page returns. */
export function keepScreenOn() {
  if (!wanted) {
    wanted = true
    document.addEventListener('visibilitychange', () => {
      if (wanted && document.visibilityState === 'visible') void request()
    })
  }
  void request()
}
