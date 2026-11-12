import { useEffect, useRef, useState } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName, unlockSpeechOutput } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import { bootSkipped } from './lib/bootSkip'
import { clearConversation, loadConversation, saveConversation } from './lib/persist'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool, attention } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  watchOrphanAnswers,
  newConversation,
  saveSessionState,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { getMic, startAnalyser, restartAnalyser, micLevel } from './lib/audio'
import { keepScreenOn } from './lib/wakeLock'
import { probeCapabilities } from './lib/capabilities'
import { env, BRIDGE_HTTP_URL } from './config'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = '(?:jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  /** The page was put away (screen locked, app switched) and must be woken. */
  const [asleep, setAsleep] = useState(false)
  /**
   * The conversation this page found on opening — left by a page that was
   * swiped away. Restored to the screen at once; the tap that starts JARVIS
   * then continues it, skipping the start-up sequence.
   */
  const [saved] = useState(loadConversation)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  /**
   * The turn whose voice was cut when the page was put away. Its words keep
   * arriving (the bridge kept the session) and go on screen, but are not read
   * out: coming back to the phone should not start him talking mid-answer, or
   * say again what was already half said.
   */
  const silencedTurn = useRef(0)
  /** A resume in progress, so a second tap or error does not start another. */
  const resuming = useRef(false)
  /** The last utterance taken, to drop the same one arriving twice. */
  const lastHeard = useRef({ text: '', at: 0 })
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    // One voice at a time: whatever the previous turn was still saying stops
    // here, so two answers can never be heard over each other.
    speaker.current?.cancel()
    const spk = createSpeaker()
    speaker.current = spk
    const silenced = () => silencedTurn.current === mine
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    try {
      const { text } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          if (!silenced()) spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started && !silenced()) {
            filled = true
            spk.say(forTool(name))
          }
        },
      })

      if (stale()) return

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing)
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    // Starting over, and quitting, are commands — never questions for the model.
    const command = said.toLowerCase().replace(/[^\p{L}\s]/gu, '').trim()
    if (/^(nieuw gesprek|nieuwe conversatie|begin opnieuw|new conversation|start over|start a new conversation)$/.test(command)) {
      startOver(false)
      return
    }
    if (/^(sluit af|afsluiten|stop jarvis|quit|quit jarvis|shut down)$/.test(command)) {
      startOver(true)
      return
    }

    // The same words twice within a moment are one utterance heard by two
    // listeners (or delivered twice), not two questions. Answering both is
    // what produced two voices over each other.
    const key = said.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const now = Date.now()
    if (key === lastHeard.current.text && now - lastHeard.current.at < 2500) return
    lastHeard.current = { text: key, at: now }

    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    // On a phone, coming back from another app often ends in the recogniser
    // being refused the microphone — iOS takes it away from pages in the
    // background. That is not a verdict, it is a nap: ask for a tap (the one
    // thing that wins the microphone back) rather than leaving him deaf
    // behind an error that never clears.
    const p = store.getState().phase
    if (/microphone/i.test(message) && p !== 'offline' && p !== 'boot') {
      if (!resuming.current) setAsleep(true)
      return
    }
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()
    // Coming back to a conversation, not switching on: no fanfare.
    const quick = saved !== null

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture. The speech
    // output first, before anything awaits: iOS stops counting the tap once
    // the handler has yielded.
    unlockSpeechOutput()
    keepScreenOn()
    await sfx.unlockAudio()
    // The score. Must be started from inside this click handler for the same
    // reason as the rest of the audio.
    music.enable()
    if (!quick) {
      sfx.play('boot')
      music.playBoot()
      music.startAmbient()
      s.setPhase('boot')
    } else {
      s.setPhase('thinking')
    }

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      // The bridge keeps the session while the page is away and hands it
      // back on reconnect, so a drop is a pause, not a loss. Only one that
      // happens while you are looking is worth a word.
      if (state === 'lost') {
        if (document.visibilityState === 'visible') {
          store.getState().setError('Bridge connection lost — reconnecting.')
        }
      } else if (state === 'reconnected') {
        store.getState().setError('')
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, suit schematic, reactor power-up — before the live
    // interface takes over. Kept a touch under the boot cue so the music is
    // still rising as the reactor lands.
    // The skip button (or Escape) ends the wait at once and cuts the start-up
    // music short, rather than leaving it playing under the live interface.
    if (!quick) await Promise.race([
      new Promise((r) => setTimeout(r, 9200)), // boot sequence
      bootSkipped().then(() => music.cutBoot()),
    ])
    await warming
    store.getState().setConnected(connectedLabels())
    void restoreTranscript()

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[jarvis] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload. The HUD label is set only
    // after this resolves, or it always reports the browser fallback voice
    // even when ElevenLabs is the one actually about to speak.
    await probeCapabilities()
    store.getState().setVoice(currentVoiceName())

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice({
      mode,
      onWake,
      onSpeechStart,
      onPartial,
      onUtterance,
      onError: onVoiceError,
    })

    store.getState().setPhase('dormant')
  }

  /**
   * The last exchanges, back on screen. The bridge keeps every conversation;
   * a fresh page — or one reopened on the phone — starts by showing where it
   * was, so "as I said" has something to point at.
   */
  const restoreTranscript = async () => {
    if (!usingBridge || store.getState().turns.length) return
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/history?limit=6`)
      const { exchanges } = (await res.json()) as {
        exchanges?: { user: string; jarvis: string }[]
      }
      for (const e of exchanges ?? []) {
        store.getState().pushTurn({ id: newId(), role: 'user', text: e.user })
        store.getState().pushTurn({ id: newId(), role: 'jarvis', text: e.jarvis })
      }
    } catch {
      /* nothing to show */
    }
  }

  // -- coming back after the phone slept -------------------------------------

  /**
   * After the screen has been off or the app put away, a phone has quietly
   * taken everything: the microphone, the sound, the connection. Nothing
   * reports it — he simply never hears another word. So when the page comes
   * back after being hidden, the interface asks for one tap, and that tap (the
   * gesture iOS insists on before sound may play again) rebuilds the lot in
   * place: no reload, no start-up sequence, the conversation where it was.
   */
  useEffect(() => {
    let hiddenAt = 0
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        // Put away: a pause. Stop the voice — only the voice. The session,
        // the answer being written and the conversation all carry on.
        silencedTurn.current = turn.current
        speaker.current?.cancel()
        return
      }
      const away = hiddenAt ? Date.now() - hiddenAt : 0
      hiddenAt = 0
      const p = store.getState().phase
      if (away > 3000 && p !== 'offline' && p !== 'boot') setAsleep(true)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [store])

  // -- the conversation survives the app being swiped away ------------------

  useEffect(() => {
    // What the last page left on screen, back on screen before anything else.
    if (saved && !store.getState().turns.length) {
      for (const t of saved.turns) store.getState().pushTurn(t)
    }

    // Written down on every change to the conversation (a little later, so a
    // streaming answer is not written forty times a second)…
    let timer = 0
    const save = () => {
      clearTimeout(timer)
      timer = 0
      const st = store.getState()
      saveConversation(st.turns, st.phase)
      saveSessionState()
    }
    const unsubscribe = store.subscribe((st, prev) => {
      if (st.turns !== prev.turns && !timer) timer = window.setTimeout(save, 400)
    })
    // …and at once when the page is put away or torn down, with the voice
    // stopped so nothing is left speaking over the next page.
    const away = () => {
      speaker.current?.cancel()
      save()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') away()
    }
    window.addEventListener('pagehide', away)
    document.addEventListener('visibilitychange', onVisibility)

    // An answer the killed page asked for, finished while nobody was here.
    watchOrphanAnswers((text) => {
      const st = store.getState()
      const last = st.turns[st.turns.length - 1]
      if (last?.role === 'jarvis' && text.startsWith(last.text)) {
        if (text.length > last.text.length) st.appendToLastTurn(text.slice(last.text.length))
      } else if (!st.turns.some((t) => t.role === 'jarvis' && t.text === text)) {
        st.pushTurn({ id: newId(), role: 'jarvis', text })
      }
    })

    return () => {
      unsubscribe()
      clearTimeout(timer)
      window.removeEventListener('pagehide', away)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  /**
   * Starting over is deliberate: "new conversation" (or quitting) ends the
   * session at the bridge, takes a new session id, and clears the screen and
   * what was saved. Nothing else ever clears it.
   */
  const startOver = (quit: boolean) => {
    speaker.current?.cancel()
    newConversation()
    clearConversation()
    const st = store.getState()
    st.clearScreen('all')
    if (quit) {
      voice.current?.stop()
      voice.current = null
      booting.current = false
      st.setPhase('offline')
    } else {
      st.setPhase('dormant')
    }
  }

  const resume = async () => {
    // Taps arrive in bursts on a phone; one resume at a time.
    if (resuming.current) return
    resuming.current = true
    try {
      await resumeOnce()
    } finally {
      resuming.current = false
    }
  }

  const resumeOnce = async () => {
    setAsleep(false)
    store.getState().setError('')
    // Everything that needs the tap, first, before anything awaits — the
    // microphone above all, which iOS only grants inside the tap itself.
    const mic = getMic().catch(() => null)
    unlockSpeechOutput()
    keepScreenOn()
    music.enable()
    await sfx.unlockAudio()
    speaker.current?.cancel()
    voice.current?.stop()
    voice.current = null
    void warm().catch(() => {})
    await mic
    try {
      await restartAnalyser()
    } catch {
      /* the reactor just will not pulse */
    }
    try {
      voice.current = await startVoice({
        mode,
        onWake,
        onSpeechStart,
        onPartial,
        onUtterance,
        onError: onVoiceError,
      })
    } catch (err) {
      store.getState().setError(String((err as Error)?.message ?? err))
    }
    // An answer still being written finishes on its own and sets the phase
    // itself; only an idle interface goes back to waiting for its name.
    const p = store.getState().phase
    if (p !== 'thinking' && p !== 'tooling' && p !== 'speaking') {
      store.getState().setPhase('dormant')
    }
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
      }
    }
    window.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      <Hud />
      <Boot />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} resume={saved !== null} />
      {asleep && (
        <button type="button" className="wake-overlay" onClick={() => void resume()}>
          <span className="wake-ring" aria-hidden="true" />
          <span className="wake-word">TIK OM VERDER TE GAAN</span>
          <span className="wake-sub">Jarvis was in slaap gezet door je telefoon</span>
        </button>
      )}
    </>
  )
}
