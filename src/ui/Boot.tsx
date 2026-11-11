import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useStore } from '../store'
import { skipBoot } from '../lib/bootSkip'

/**
 * The start-up sequence, rebuilt to the Iron Man boot it is quoting.
 *
 * Four beats, in order, cyan on black:
 *   1. an angular status bar — "INITIATING SYSTEM" — over a scrolling boot log,
 *      with a segmented bar filling left to right;
 *   2. concentric reticle rings assembling inward, turning against each other,
 *      until "J.A.R.V.I.S" resolves at the centre;
 *   3. the suit schematic — a wireframe figure with component call-outs, a
 *      scan line sweeping it;
 *   4. the arc reactor charging: a tick ring and a segmented ring turning, the
 *      power segments lighting one by one, the triangular core flaring white,
 *      and a shock ring going out as it reaches full power — the hand-off into
 *      the live scene behind it.
 *
 * Behind all four: a faint grid, a vignette, scan lines, HUD corners and a
 * power counter climbing to 100%. A SKIP button (or Escape) ends it at once.
 *
 * It is one full-frame overlay driven by a small stage clock rather than four
 * components, so the timing is legible in one place. Everything is SVG and CSS
 * — no images to load, nothing that can arrive late and stall the first beat,
 * and light enough for a phone.
 */

/** The stage boundaries, in milliseconds from power-on. App owns the actual
 *  hand-off (at 9.2 s); this is only for pacing. */
const T = { rings: 2600, suit: 5200, reactor: 7200, end: 9200 }

const LOG = [
  'MOUNT F:/BACKUP/GHOST (HIDDEN)',
  'EXTEND SYSTEM MEMORY .......... OK',
  'TELEMETRY / COMP CLIMATION',
  'REMOVE SYSTEM CONFIGURATION',
  'CHECKSUM ...................... OK',
  'RUN SYSTEM TOOL',
]

type Stage = 'bar' | 'rings' | 'suit' | 'reactor'

export function Boot() {
  const phase = useStore((s) => s.phase)
  const reduced = useReducedMotion()
  const [t, setT] = useState(0)

  // A single clock: elapsed milliseconds since the boot phase began. Every
  // stage reads from it, so nothing can drift out of step with anything else.
  //
  // Driven by setInterval over wall-clock time, NOT requestAnimationFrame —
  // rAF is throttled to a crawl (and paused outright) whenever the tab is not
  // the focused one, which froze the sequence on its first beat. An interval
  // reading Date.now advances by real elapsed time whatever the browser does
  // with its frame budget: throttling can cost smoothness, never correctness.
  useEffect(() => {
    if (phase !== 'boot') {
      setT(0)
      return
    }
    const start = Date.now()
    setT(0)
    const id = setInterval(() => setT(Date.now() - start), 50)
    return () => clearInterval(id)
  }, [phase])

  // Escape skips, like the button.
  useEffect(() => {
    if (phase !== 'boot') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') skipBoot()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase])

  if (phase !== 'boot') return null

  const stage: Stage =
    t >= T.reactor ? 'reactor' : t >= T.suit ? 'suit' : t >= T.rings ? 'rings' : 'bar'

  const logShown = Math.min(LOG.length, Math.floor((t / T.rings) * (LOG.length + 1)))
  const barPct = Math.min(1, t / (T.rings - 300))
  const power = Math.min(100, Math.round((t / (T.end - 600)) * 100))

  return (
    <AnimatePresence>
      <motion.div
        className="boot"
        initial={{ opacity: 1 }}
        exit={{ opacity: 0, filter: 'blur(10px)' }}
        transition={{ duration: 0.8 }}
      >
        {/* ---- the room: grid, glow, scan lines, HUD corners ---- */}
        <div className="boot-bg" aria-hidden="true" />
        <div className="boot-scan" aria-hidden="true" />
        <div className="boot-corners" aria-hidden="true">
          <span className="boot-c-tl" />
          <span className="boot-c-tr" />
          <span className="boot-c-bl" />
          <span className="boot-c-br" />
        </div>

        {/* ---- beat 1: the status bar, dimming once its work is done ---- */}
        <div className={`boot-bar ${stage !== 'bar' ? 'boot-bar-dim' : ''}`}>
          <div className="boot-bar-frame">
            <span className="boot-bar-title">
              INITIATING SYSTEM 1<span className="boot-dots">…</span>
              <span className="boot-cursor" />
            </span>
            <div className="boot-seg">
              {Array.from({ length: 22 }, (_, i) => (
                <span
                  key={i}
                  className="boot-seg-cell"
                  data-on={i / 22 < barPct ? '1' : '0'}
                />
              ))}
            </div>
          </div>
          <div className="boot-log">
            {LOG.slice(0, logShown).map((l) => (
              <div key={l} className="boot-log-line">
                {l}
              </div>
            ))}
          </div>
        </div>

        {/* ---- beats 2-4: the centre stage ---- */}
        <div className="boot-stage">
          {stage === 'rings' && <Rings reduced={!!reduced} />}
          {stage === 'suit' && <Suit reduced={!!reduced} />}
          {stage === 'reactor' && <Reactor reduced={!!reduced} t={t - T.reactor} />}
        </div>

        {/* ---- the readout, and the way out ---- */}
        <div className="boot-readout" aria-hidden="true">
          <span>PWR</span>
          <b>{String(power).padStart(3, '0')}%</b>
          <span className="boot-readout-stage">
            {stage === 'bar' ? 'SYS INIT' : stage === 'rings' ? 'CORE SYNC' : stage === 'suit' ? 'MK DIAG' : 'ARC REACTOR'}
          </span>
        </div>
        <button type="button" className="boot-skip" onClick={() => skipBoot()}>
          SKIP <span aria-hidden="true">›</span>
        </button>
      </motion.div>
    </AnimatePresence>
  )
}

/* ------------------------------------------------------------------ shared */

/** A ring of tick marks, every sixth one long — the reactor's dial. */
function Ticks({ r, n = 72, long = 6 }: { r: number; n?: number; long?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2
        const big = i % long === 0
        const r0 = r - (big ? 10 : 5)
        return (
          <line
            key={i}
            x1={Math.cos(a) * r0}
            y1={Math.sin(a) * r0}
            x2={Math.cos(a) * r}
            y2={Math.sin(a) * r}
            className={big ? 'boot-tick boot-tick-long' : 'boot-tick'}
          />
        )
      })}
    </>
  )
}

/** A ring broken into arcs with small gaps. */
function Segments({ r, n, width, gap = 0.06, className }: {
  r: number
  n: number
  width: number
  gap?: number
  className?: string
}) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        const a0 = (i / n) * Math.PI * 2 + gap
        const a1 = ((i + 1) / n) * Math.PI * 2 - gap
        const d = `M${Math.cos(a0) * r},${Math.sin(a0) * r} A${r},${r} 0 0 1 ${Math.cos(a1) * r},${Math.sin(a1) * r}`
        return <path key={i} d={d} className={className} strokeWidth={width} />
      })}
    </>
  )
}

/* ------------------------------------------------------------------ beat 2 */

/** Concentric reticle rings drawing inward, with the name resolving last. */
function Rings({ reduced }: { reduced: boolean }) {
  const ease = 'easeOut'
  const ring = (r: number, delay: number, dash: string, w = 1) => (
    <motion.circle
      cx="0"
      cy="0"
      r={r}
      className="boot-ring"
      strokeDasharray={dash}
      strokeWidth={w}
      initial={reduced ? { opacity: 1 } : { opacity: 0, rotate: -40, scale: 1.15 }}
      animate={{ opacity: 1, rotate: 0, scale: 1 }}
      transition={{ duration: 0.7, delay, ease }}
    />
  )
  return (
    <svg className="boot-rings" viewBox="-170 -170 340 340">
      <g className={reduced ? '' : 'boot-spin'}>
        <Ticks r={164} />
      </g>
      <g className={reduced ? '' : 'boot-spin-rev'}>
        {ring(150, 0.0, '3 6')}
        {ring(128, 0.08, '40 8 12 8', 1.4)}
      </g>
      <g className={reduced ? '' : 'boot-spin-fast'}>
        {ring(104, 0.16, '2 4')}
        {ring(84, 0.24, '30 6 6 6', 1.6)}
      </g>
      {ring(60, 0.34, '1 3')}
      <motion.text
        x="0"
        y="6"
        className="boot-name"
        initial={reduced ? { opacity: 1 } : { opacity: 0, letterSpacing: '1.4em' }}
        animate={{ opacity: 1, letterSpacing: '0.42em' }}
        transition={{ duration: 0.7, delay: 0.5, ease }}
      >
        J.A.R.V.I.S
      </motion.text>
    </svg>
  )
}

/* ------------------------------------------------------------------ beat 3 */

/**
 * The suit schematic — a wireframe figure flanked by component call-outs, the
 * way the film flashes the armour blueprint mid-boot. Not the actual Mark VII
 * geometry, but the same read: a lit humanoid outline and exploded diagrams.
 */
function Suit({ reduced }: { reduced: boolean }) {
  return (
    <svg className="boot-suit" viewBox="-200 -150 400 300">
      <defs>
        <linearGradient id="boot-scan-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
          <stop offset="0.5" style={{ stopColor: 'var(--accent)', stopOpacity: 0.55 }} />
          <stop offset="1" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <motion.g
        className="boot-suit-fig"
        initial={reduced ? { opacity: 1 } : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <motion.path
          className="boot-wire"
          d="M0,-118 C11,-118 17,-108 17,-96 C17,-86 12,-80 12,-74
             L22,-64 L30,-30 L26,26 L34,64 L28,66 L18,30 L16,64 L20,110
             L6,112 L2,66 L-2,66 L-6,112 L-20,110 L-16,64 L-18,30 L-28,66
             L-34,64 L-26,26 L-30,-30 L-22,-64 L-12,-74 C-12,-80 -17,-86 -17,-96
             C-17,-108 -11,-118 0,-118 Z"
          initial={reduced ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 1.4, ease: 'easeInOut' }}
        />
        <path className="boot-wire boot-wire-dim" d="M-9,-104 L9,-104 M-8,-96 L8,-96 M0,-92 L0,-84" />
        <circle className="boot-wire" cx="0" cy="-40" r="9" />
        <path className="boot-wire boot-wire-dim" d="M0,-49 L0,-31 M-9,-40 L9,-40" />
      </motion.g>

      {/* The scan line, sweeping the figure top to bottom. */}
      {!reduced && (
        <motion.rect
          x="-60"
          width="120"
          height="18"
          fill="url(#boot-scan-grad)"
          initial={{ y: -130 }}
          animate={{ y: [-130, 110, -130] }}
          transition={{ duration: 2, ease: 'easeInOut' }}
        />
      )}

      {[-150, 150].map((x, i) => (
        <motion.g
          key={x}
          className="boot-callout"
          initial={reduced ? { opacity: 1 } : { opacity: 0, x: x > 0 ? 20 : -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.3 + i * 0.12 }}
        >
          <g className={reduced ? '' : i ? 'boot-spin-rev' : 'boot-spin'}>
            <circle className="boot-wire" cx={x} cy="-10" r="26" strokeDasharray="30 6 6 6" />
          </g>
          <circle className="boot-wire boot-wire-dim" cx={x} cy="-10" r="15" />
          <circle className="boot-wire" cx={x} cy="-10" r="3" />
          <path
            className="boot-wire boot-wire-dim"
            d={x > 0 ? `M${x - 26},-10 L60,-10` : `M${x + 26},-10 L-60,-10`}
          />
        </motion.g>
      ))}
      <text x="-150" y="34" className="boot-tag">RT / PWR</text>
      <text x="150" y="34" className="boot-tag">DEP / MK</text>
    </svg>
  )
}

/* ------------------------------------------------------------------ beat 4 */

/**
 * The arc reactor charging: dials turning, power segments lighting one by
 * one, the triangular core flaring white — and at full power a shock ring
 * going out and a flash, before the live scene takes over.
 */
function Reactor({ reduced, t }: { reduced: boolean; t: number }) {
  const glow = reduced ? 1 : Math.min(1, Math.max(0, t / 1400))
  const full = glow >= 1
  const seg = Array.from({ length: 24 }, (_, i) => i)
  return (
    <svg
      className="boot-reactor"
      viewBox="-170 -170 340 340"
      style={{ ['--glow' as string]: glow }}
    >
      <defs>
        <radialGradient id="boot-core" cx="0" cy="0" r="1" gradientUnits="objectBoundingBox">
          <stop offset="0" style={{ stopColor: '#ffffff', stopOpacity: 1 }} />
          <stop offset="0.35" style={{ stopColor: 'var(--accent)', stopOpacity: 0.85 }} />
          <stop offset="1" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
        </radialGradient>
      </defs>

      {/* The halo, swelling as it charges. */}
      <circle cx="0" cy="0" r={90 + glow * 70} fill="url(#boot-core)" opacity={0.12 + glow * 0.3} />

      <g className={reduced ? '' : 'boot-spin'}>
        <Ticks r={160} />
      </g>
      <circle className="boot-r-ring" cx="0" cy="0" r="140" />
      <g className={reduced ? '' : 'boot-spin-rev'}>
        <Segments r={126} n={10} width={7} className="boot-r-arc" />
      </g>

      {/* The power segments, lighting in sequence. */}
      {seg.map((i) => {
        const a = (i / seg.length) * Math.PI * 2 - Math.PI / 2
        const on = i / seg.length < glow * 1.02
        return (
          <line
            key={i}
            x1={Math.cos(a) * 78}
            y1={Math.sin(a) * 78}
            x2={Math.cos(a) * 106}
            y2={Math.sin(a) * 106}
            className={on ? 'boot-r-seg boot-r-on' : 'boot-r-seg'}
          />
        )
      })}
      <circle className="boot-r-ring boot-r-ring-in" cx="0" cy="0" r="70" />

      <g className={reduced ? '' : 'boot-spin-fast'}>
        <Segments r={60} n={3} width={2} gap={0.5} className="boot-r-arc boot-r-arc-thin" />
      </g>

      <path className="boot-r-tri" d="M0,-52 L46,30 L-46,30 Z" />
      <path className="boot-r-tri boot-r-tri-in" d="M0,-30 L28,20 L-28,20 Z" />
      <path className="boot-r-v" d="M-11,-4 L0,14 L11,-4" />
      <circle cx="0" cy="0" r={10 + glow * 18} fill="url(#boot-core)" opacity={glow} />

      {/* Full power: a ring going out, and a flash. */}
      {full && !reduced && (
        <>
          <motion.circle
            cx="0"
            cy="0"
            className="boot-shock"
            initial={{ r: 60, opacity: 0.9 }}
            animate={{ r: 260, opacity: 0 }}
            transition={{ duration: 1.1, ease: 'easeOut' }}
          />
          <motion.circle
            cx="0"
            cy="0"
            r="170"
            fill="url(#boot-core)"
            initial={{ opacity: 0.55 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 0.7 }}
          />
        </>
      )}
      <text x="0" y="98" className="boot-r-label">
        {full ? 'ONLINE' : `${Math.round(glow * 100)}%`}
      </text>
    </svg>
  )
}
