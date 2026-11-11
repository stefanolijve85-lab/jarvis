/**
 * The talk app: JARVIS on a phone, as a conversation rather than a cockpit.
 *
 * The full interface is a 3D scene built for a desktop GPU and leans on
 * Chrome's own speech recognition, which an iPhone does not reliably have. This
 * page does the one thing a phone needs — talk and listen — and does it in a
 * way that works in Safari:
 *
 *   ear    — the microphone is read as raw samples through Web Audio, a small
 *            energy detector decides when you have stopped talking, and the
 *            samples go to the bridge's /listen, where Whisper transcribes them
 *            on your own computer.
 *   brain  — the same agent as everywhere else, over the bridge's socket with
 *            ?mode=talk, which leaves out the screen tools.
 *   mouth  — the phone's own speech synthesis, sentence by sentence as the
 *            answer arrives.
 *
 * In conversation mode it listens again as soon as he has finished speaking,
 * so it behaves like a call: tap once to start, tap again to hang up.
 *
 * The microphone is released while he speaks. That keeps him from hearing
 * himself, and on an iPhone it keeps his voice on the loudspeaker — with the
 * microphone open, iOS plays audio at earpiece volume.
 */

import { BRIDGE_HTTP_URL, BRIDGE_WS_URL } from '../config'
import './talk.css'

// ------------------------------------------------------------------- the page

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const log = $<HTMLElement>('log')
const hint = $<HTMLElement>('hint')
const statusEl = $<HTMLElement>('status')
const orb = $<HTMLButtonElement>('orb')
const linkEl = $<HTMLElement>('link')
const linkText = $<HTMLElement>('link-text')
const typeForm = $<HTMLFormElement>('type')
const textInput = $<HTMLInputElement>('text')

type Phase = 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking'
let phase: Phase = 'idle'
/** In a conversation, listening resumes after every answer. */
let inCall = false
let language = 'nl-NL'

const LABELS: Record<Phase, string> = {
  idle: 'Tik om te praten',
  listening: 'Ik luister…',
  hearing: 'Ik luister…',
  thinking: 'Even denken…',
  speaking: 'Tik om te onderbreken',
}

function setPhase(next: Phase, label?: string) {
  phase = next
  document.body.dataset.phase = next
  document.body.dataset.call = inCall ? 'on' : 'off'
  statusEl.textContent = label ?? (next === 'idle' && inCall ? 'Tik om op te hangen' : LABELS[next])
}

function bubble(who: 'me' | 'him' | 'note', text: string) {
  hint.remove()
  const el = document.createElement('p')
  el.className = `msg ${who}`
  el.textContent = text
  log.append(el)
  log.scrollTop = log.scrollHeight
  return el
}

// -------------------------------------------------------------- the bridge

let socket: WebSocket | null = null
let ready = false
let retry = 0
let asked = 0
let current: string | null = null
let answerEl: HTMLElement | null = null

function wsUrl() {
  const url = new URL(BRIDGE_WS_URL)
  url.searchParams.set('mode', 'talk')
  return url.toString()
}

function connect() {
  const ws = new WebSocket(wsUrl())
  socket = ws
  linkEl.dataset.state = 'connecting'
  linkText.textContent = 'verbinden…'

  ws.onopen = () => {
    retry = 0
  }
  ws.onmessage = (event) => {
    let msg: { type: string; ask?: string | null; delta?: string; text?: string; message?: string }
    try {
      msg = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (msg.type === 'ready') {
      ready = true
      linkEl.dataset.state = 'up'
      linkText.textContent = 'verbonden'
      return
    }
    // Anything tagged for a question we have since abandoned is the tail of
    // an interrupted answer.
    if ('ask' in msg && msg.ask !== current) return
    if (msg.type === 'text' && msg.delta) onDelta(msg.delta)
    else if (msg.type === 'done') onDone(msg.text ?? '')
    else if (msg.type === 'error') onFailed(msg.message ?? 'Er ging iets mis.')
  }
  ws.onclose = () => {
    ready = false
    linkEl.dataset.state = 'down'
    linkText.textContent = 'geen verbinding'
    if (phase === 'thinking' || phase === 'speaking') onFailed('De verbinding viel weg.')
    setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++))
  }
}

function ask(text: string) {
  if (!socket || !ready) {
    bubble('note', 'Geen verbinding met Jarvis. Draait hij op je computer?')
    setPhase('idle')
    return
  }
  bubble('me', text)
  current = `t${++asked}`
  answerEl = null
  spoken = ''
  pending = ''
  turnDone = false
  setPhase('thinking')
  socket.send(JSON.stringify({ type: 'ask', text, id: current }))
}

function interrupt() {
  if (current && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'interrupt' }))
  }
  current = null
  speech.cancel()
}

// ---------------------------------------------------------------- the mouth

const speech = window.speechSynthesis
let voice: SpeechSynthesisVoice | null = null
let pending = ''
let spoken = ''
let turnDone = false
let queued = 0

function pickVoice() {
  const prefix = language.toLowerCase().split('-')[0]
  const voices = speech?.getVoices() ?? []
  const mine = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(prefix))
  // Exact region first (nl-NL over nl-BE), then any local voice, then any.
  voice =
    mine.find((v) => v.lang.toLowerCase().replace('_', '-') === language.toLowerCase() && v.localService) ??
    mine.find((v) => v.lang.toLowerCase().replace('_', '-') === language.toLowerCase()) ??
    mine.find((v) => v.localService) ??
    mine[0] ??
    null
}
if (speech) {
  pickVoice()
  speech.addEventListener?.('voiceschanged', pickVoice)
}

/**
 * Where the phone sends sound. On an iPhone, once the microphone has been
 * open the page is in a recording session, and in that session speech goes to
 * the earpiece — so quietly you would not know he was talking — or nowhere.
 * Safari 17+ lets a page say which it wants: 'playback' while he speaks puts
 * him on the loudspeaker (and past the silent switch), 'play-and-record' while
 * he listens.
 */
type AudioSessionType = 'auto' | 'playback' | 'play-and-record'
function audioSession(type: AudioSessionType) {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
  if (!session) return
  try {
    session.type = type
  } catch {
    /* not supported here */
  }
}

/** Speech must first be started inside a tap on iOS, or it never plays. */
let unlocked = false
function unlockSpeech() {
  if (unlocked || !speech) return
  unlocked = true
  // An empty utterance does not count on every iOS version; a real word,
  // silent, does.
  const u = new SpeechSynthesisUtterance('ja')
  u.volume = 0
  u.lang = language
  speech.speak(u)
}

/** Said once, if the phone never actually starts speaking. */
let warnedSilent = false

function say(sentence: string) {
  const text = sentence.trim()
  if (!text || !speech) return
  const u = new SpeechSynthesisUtterance(text)
  u.lang = language
  if (voice) u.voice = voice
  u.rate = 1.05
  queued++
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    queued = Math.max(0, queued - 1)
    maybeDoneSpeaking()
  }
  u.onend = finish
  u.onerror = finish
  let began = false
  u.onstart = () => {
    began = true
  }
  // iOS sometimes never reports the end of an utterance.
  setTimeout(finish, 2500 + text.length * 110)
  setTimeout(() => {
    if (began || warnedSilent || finished) return
    warnedSilent = true
    bubble(
      'note',
      'Je telefoon speelt zijn stem niet af. Zet de stille-modusknop uit en het volume ' +
        'omhoog, en tik daarna nog eens op de knop.',
    )
  }, 2000)
  if (phase === 'thinking') setPhase('speaking')
  // Off the microphone and onto the loudspeaker before the first word.
  audioSession('playback')
  void audio?.suspend().catch(() => {})
  // A synthesiser left paused (iOS does this after an interruption) speaks
  // nothing until resumed.
  speech.resume()
  speech.speak(u)
}

/** Speaks every complete sentence in what has arrived so far. */
function flushSentences(final: boolean) {
  const re = /[^.!?…\n]+[.!?…]+["')\]]*\s+|[^\n]+\n+/g
  let consumed = 0
  for (let m = re.exec(pending); m; m = re.exec(pending)) {
    say(m[0])
    consumed = re.lastIndex
  }
  pending = pending.slice(consumed)
  if (final && pending.trim()) {
    say(pending)
    pending = ''
  }
}

function onDelta(delta: string) {
  answerEl ??= bubble('him', '')
  spoken += delta
  answerEl.textContent = spoken
  log.scrollTop = log.scrollHeight
  pending += delta
  flushSentences(false)
}

function onDone(text: string) {
  if (!answerEl && text) {
    answerEl = bubble('him', text)
    pending = text
  }
  turnDone = true
  current = null
  flushSentences(true)
  maybeDoneSpeaking()
}

function onFailed(message: string) {
  current = null
  turnDone = true
  bubble('note', message)
  speech?.cancel()
  queued = 0
  inCall = false
  setPhase('idle')
}

function maybeDoneSpeaking() {
  if (!turnDone || queued > 0) return
  // Still talking even though every utterance has reported in — iOS is not
  // always prompt about it. Look again shortly rather than wait for an event
  // that may never come.
  if (speech?.speaking) {
    setTimeout(maybeDoneSpeaking, 300)
    return
  }
  turnDone = false
  if (inCall) void listen()
  else setPhase('idle')
}

// ------------------------------------------------------------------ the ear

const RATE = 16_000
let audio: AudioContext | null = null
/** Ends listening: `true` sends what was heard, `false` throws it away. */
let stopListening: ((send: boolean) => void) | null = null

/** Averages the input down to 16 kHz, which is what Whisper takes. */
function downsample(input: Float32Array, from: number): Float32Array {
  if (from === RATE) return input.slice()
  const ratio = from / RATE
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    out[i] = sum / Math.max(1, end - start)
  }
  return out
}

async function listen() {
  if (stopListening) return
  let stream: MediaStream
  try {
    audioSession('play-and-record')
    audio ??= new AudioContext()
    await audio.resume()
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch (err) {
    inCall = false
    const denied = err instanceof DOMException && err.name === 'NotAllowedError'
    bubble(
      'note',
      denied
        ? 'De microfoon is niet toegestaan. Sta hem toe in de instellingen van je browser.'
        : 'Er is geen microfoon beschikbaar.',
    )
    setPhase('idle')
    return
  }

  const ctx = audio
  const source = ctx.createMediaStreamSource(stream)
  // ScriptProcessor is deprecated, and still the one thing every browser —
  // Safari included — runs without a separate worklet file.
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  const frames: Float32Array[] = []
  const frameMs = (4096 / ctx.sampleRate) * 1000

  const recent: number[] = []
  let speechFrames = 0
  let started = -1
  let silentMs = 0
  let totalMs = 0
  let done = false

  setPhase('listening')

  const finish = (send: boolean) => {
    if (done) return
    done = true
    stopListening = null
    proc.disconnect()
    source.disconnect()
    for (const track of stream.getTracks()) track.stop()
    // Leave the recording session as soon as there is nothing to record, so
    // whatever is played next goes to the loudspeaker.
    audioSession('playback')
    if (!send || started < 0) {
      if (inCall && send) {
        // Nothing said for a while: stay in the call, but stop listening.
        setPhase('idle', 'Ik hoorde niets — tik om verder te praten')
        inCall = false
        document.body.dataset.call = 'off'
      } else setPhase('idle')
      return
    }
    // Keep a little before the first sound, so the first syllable survives.
    const from = Math.max(0, started - 3)
    const chunks = frames.slice(from)
    const length = chunks.reduce((n, c) => n + c.length, 0)
    const all = new Float32Array(length)
    let at = 0
    for (const c of chunks) {
      all.set(c, at)
      at += c.length
    }
    void transcribeAndAsk(downsample(all, ctx.sampleRate))
  }
  stopListening = finish

  proc.onaudioprocess = (event) => {
    if (done) return
    const data = event.inputBuffer.getChannelData(0)
    frames.push(new Float32Array(data))
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length)
    totalMs += frameMs
    orb.style.setProperty('--level', String(Math.min(1, rms * 12)))

    // What counts as the room is the quietest the last four seconds have been
    // (minimum statistics). Speech always has gaps between words, so this
    // finds the background under it; and a fan or a television that starts
    // later raises the bar within seconds instead of being taken for a voice
    // that never stops. A microphone still starting up delivers exact zeros,
    // which say nothing about the room and are skipped.
    if (rms > 0) {
      recent.push(rms)
      if (recent.length > 44) recent.shift()
    }
    if (recent.length < 4) return
    const floor = Math.min(...recent)
    const threshold = Math.max(0.012, floor * 2.5)
    if (rms > threshold) {
      speechFrames++
      silentMs = 0
      if (started < 0 && speechFrames >= 2) {
        started = frames.length - 2
        setPhase('hearing')
      }
    } else {
      speechFrames = 0
      if (started >= 0) silentMs += frameMs
    }
    if (started >= 0 && silentMs > 1100) finish(true)
    else if (started < 0 && totalMs > 10_000) finish(true)
    else if (totalMs > 30_000) finish(true)
  }
  source.connect(proc)
  // Some browsers only run the processor when it leads somewhere; a muted
  // gain keeps the microphone off the loudspeaker.
  const mute = ctx.createGain()
  mute.gain.value = 0
  proc.connect(mute)
  mute.connect(ctx.destination)
}

async function transcribeAndAsk(samples: Float32Array) {
  setPhase('thinking', 'Verstaan…')
  let text = ''
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/listen`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: samples.buffer as ArrayBuffer,
    })
    const data = (await res.json().catch(() => ({}))) as { text?: string }
    if (!res.ok) throw new Error(String(res.status))
    text = (data.text ?? '').trim()
  } catch {
    onFailed(
      'Spraakherkenning werkt nu niet op je computer. Kijk in het terminalvenster van ' +
        'Jarvis wat er mis is. Typen werkt intussen wel.',
    )
    return
  }
  if (!text) {
    // Heard sound, but no words. In a call, just listen again.
    if (inCall) void listen()
    else setPhase('idle', 'Niet verstaan — tik en probeer opnieuw')
    return
  }
  ask(text)
}

// ---------------------------------------------------------------- controls

orb.addEventListener('click', () => {
  audioSession('playback')
  unlockSpeech()
  if (phase === 'listening' || phase === 'hearing') {
    // Tapping while he listens: send what you have said, or hang up if
    // nothing yet.
    if (phase === 'hearing') stopListening?.(true)
    else {
      inCall = false
      stopListening?.(false)
    }
    return
  }
  if (phase === 'speaking' || phase === 'thinking') {
    // Barge in: stop him and listen.
    interrupt()
    queued = 0
    turnDone = false
    void listen()
    return
  }
  if (inCall) {
    inCall = false
    setPhase('idle')
    return
  }
  inCall = true
  void listen()
})

typeForm.addEventListener('submit', (event) => {
  event.preventDefault()
  unlockSpeech()
  const text = textInput.value.trim()
  if (!text) return
  textInput.value = ''
  if (phase === 'speaking' || phase === 'thinking') interrupt()
  inCall = false
  stopListening?.(false)
  ask(text)
})

// ------------------------------------------------------------------- start

/** The first start downloads the speech model; say when it is there. */
async function waitForEars(note: HTMLElement) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/health`)
      const { listenState } = (await res.json()) as { listenState?: string }
      if (listenState === 'ready') {
        note.textContent = 'Spraakherkenning is klaar. Tik op de knop en praat.'
        return
      }
      if (listenState === 'failed') {
        note.textContent =
          'Spraakherkenning kon niet laden. Kijk in het terminalvenster van Jarvis. Typen werkt wel.'
        return
      }
    } catch {
      /* try again */
    }
  }
}

async function boot() {
  setPhase('idle')
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/health`)
    const health = (await res.json()) as {
      language?: string
      listen?: boolean
      listenState?: string
    }
    if (health.language) {
      language = health.language
      document.documentElement.lang = language.split('-')[0]
      pickVoice()
    }
    if (health.listen === false) {
      bubble('note', 'Spraakherkenning staat uit op je computer. Typen werkt wel.')
    } else if (health.listenState === 'loading') {
      void waitForEars(bubble('note', 'Spraakherkenning wordt geladen — de eerste keer duurt dat een paar minuten…'))
    }
  } catch {
    /* the socket reports the connection state */
  }
  if (!window.isSecureContext) {
    bubble('note', 'Open deze pagina via https (je Tailscale-adres), anders mag de microfoon niet.')
  }
  connect()
}

void boot()
