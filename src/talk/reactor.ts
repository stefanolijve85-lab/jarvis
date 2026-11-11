/**
 * The arc reactor, drawn on a 2D canvas.
 *
 * The full interface builds its reactor in Three.js with post-processing,
 * which is what makes a phone stutter. This is the same idea in flat strokes:
 * a ring of ticks turning one way, a segmented ring turning the other, the
 * triangular core, and a glow that breathes with whoever is talking — the
 * microphone while he listens, his own voice while he speaks.
 */

export type ReactorMood = 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking'

const CYAN = [0, 229, 255] as const
const rgba = (a: number, c: readonly number[] = CYAN) => `rgba(${c[0]},${c[1]},${c[2]},${a})`

export function createReactor(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!
  let mood: ReactorMood = 'idle'
  let target = 0
  let level = 0
  let spin = 0
  let counter = 0
  let last = performance.now()
  let size = 0
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

  function resize() {
    const box = canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    size = Math.max(1, Math.min(box.width, box.height))
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  new ResizeObserver(resize).observe(canvas)
  resize()

  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    // Fast to rise, slower to fall: a voice is peaks and gaps, and the glow
    // should follow the syllables without flickering on every one.
    level += (target - level) * (target > level ? 0.45 : 0.12)

    const speed = reduced
      ? 0
      : mood === 'thinking'
        ? 1.6
        : mood === 'idle'
          ? 0.12
          : 0.35 + level * 0.8
    spin += dt * speed
    counter += dt * (reduced ? 0 : 0.6)

    const s = size
    const c = s / 2
    ctx.clearRect(0, 0, s, s)
    ctx.save()
    ctx.translate(c, c)

    const bright = mood === 'idle' ? 0.45 : 0.85
    const glow = 0.25 + level * 0.75

    // The halo behind everything.
    const halo = ctx.createRadialGradient(0, 0, s * 0.05, 0, 0, s * 0.5)
    halo.addColorStop(0, rgba(0.18 + glow * 0.35))
    halo.addColorStop(0.45, rgba(0.06 + glow * 0.1))
    halo.addColorStop(1, rgba(0))
    ctx.fillStyle = halo
    ctx.fillRect(-c, -c, s, s)

    ctx.lineCap = 'round'

    // Outer ring of ticks, turning slowly clockwise.
    const rTicks = s * 0.46
    ctx.save()
    ctx.rotate(spin * 0.4)
    for (let i = 0; i < 72; i++) {
      const long = i % 6 === 0
      const a = (i / 72) * Math.PI * 2
      const r0 = rTicks - (long ? s * 0.035 : s * 0.018)
      ctx.strokeStyle = rgba((long ? 0.8 : 0.35) * bright)
      ctx.lineWidth = long ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0)
      ctx.lineTo(Math.cos(a) * rTicks, Math.sin(a) * rTicks)
      ctx.stroke()
    }
    ctx.restore()

    // Thin full ring.
    ctx.strokeStyle = rgba(0.35 * bright)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(0, 0, s * 0.405, 0, Math.PI * 2)
    ctx.stroke()

    // Segmented ring, turning the other way. Dashed and quicker while he
    // thinks, so waiting reads as work rather than as a hang.
    ctx.save()
    ctx.rotate(-spin * 0.9)
    const segs = 10
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2 + 0.06
      const a1 = ((i + 1) / segs) * Math.PI * 2 - 0.06
      ctx.strokeStyle = rgba((0.55 + glow * 0.4) * bright)
      ctx.lineWidth = s * 0.03
      ctx.beginPath()
      ctx.arc(0, 0, s * 0.355, a0, a1)
      ctx.stroke()
    }
    ctx.restore()

    // Counting arc: a short bright sweep circling while he thinks.
    if (mood === 'thinking') {
      ctx.strokeStyle = rgba(0.95)
      ctx.lineWidth = 3
      ctx.beginPath()
      const a = counter * Math.PI * 4
      ctx.arc(0, 0, s * 0.3, a, a + 0.9)
      ctx.stroke()
    }

    // Inner ring that swells with the voice.
    const rIn = s * (0.24 + level * 0.025)
    ctx.strokeStyle = rgba(0.75 * bright + glow * 0.2)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(0, 0, rIn, 0, Math.PI * 2)
    ctx.stroke()

    // The triangle — the reactor's core.
    ctx.save()
    ctx.rotate(-Math.PI / 2 + (reduced ? 0 : Math.sin(counter) * 0.03))
    const rt = s * (0.165 + level * 0.02)
    ctx.beginPath()
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2
      ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rt, Math.sin(a) * rt)
    }
    ctx.closePath()
    ctx.shadowColor = rgba(0.9)
    ctx.shadowBlur = s * (0.03 + glow * 0.06)
    ctx.strokeStyle = rgba(0.95 * bright + 0.05)
    ctx.lineWidth = s * 0.018
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.restore()

    // The white-hot centre.
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, s * (0.09 + level * 0.05))
    core.addColorStop(0, `rgba(235,253,255,${0.75 + glow * 0.25})`)
    core.addColorStop(0.4, rgba(0.6 + glow * 0.3))
    core.addColorStop(1, rgba(0))
    ctx.fillStyle = core
    ctx.beginPath()
    ctx.arc(0, 0, s * 0.15, 0, Math.PI * 2)
    ctx.fill()

    ctx.restore()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  return {
    setMood(next: ReactorMood) {
      mood = next
    },
    /** 0..1: how loud whoever is talking is right now. */
    setLevel(value: number) {
      target = Math.max(0, Math.min(1, value))
    },
  }
}
