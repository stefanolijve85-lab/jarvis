/**
 * Speech recognition on this machine: Whisper, through transformers.js.
 *
 * The talk app (talk.html) records on the phone and sends the raw samples
 * here, so nothing you say leaves your own computer and nothing costs a cent
 * per minute. Browser speech recognition is not an option on an iPhone — it is
 * unreliable there — and Twilio is a phone bill; this is neither.
 *
 * The model is downloaded once, on first use, from Hugging Face into
 * ~/.jarvis/models (a few hundred MB for whisper-small), then loaded from disk.
 * Larger is slower and more accurate: JARVIS_WHISPER_MODEL picks another, e.g.
 * onnx-community/whisper-base (faster) or onnx-community/whisper-large-v3-turbo
 * (much better, needs a strong CPU). JARVIS_WHISPER=off turns it off.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const WHISPER_MODEL =
  process.env.JARVIS_WHISPER_MODEL?.trim() || 'onnx-community/whisper-small'

export const whisperEnabled = () => process.env.JARVIS_WHISPER !== 'off'

let loading = null
let state = 'idle'

/** 'off', 'idle' (not asked for yet), 'loading', 'ready' or 'failed'. */
export const whisperState = () => (whisperEnabled() ? state : 'off')

/** Loads the model once; later calls share the same promise. */
export function loadWhisper() {
  if (!whisperEnabled()) return Promise.reject(new Error('speech recognition is switched off'))
  loading ??= (async () => {
    state = 'loading'
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = join(homedir(), '.jarvis', 'models')
    const started = Date.now()
    const asr = await pipeline('automatic-speech-recognition', WHISPER_MODEL, { dtype: 'q8' })
    console.log(
      `[jarvis] speech recognition ready — ${WHISPER_MODEL}` +
        ` (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    )
    state = 'ready'
    return asr
  })().catch((err) => {
    loading = null
    state = 'failed'
    throw err
  })
  return loading
}

/**
 * What Whisper famously "hears" in silence and noise — subtitle credits from
 * its training data. Dropped when that is all there is.
 */
const PHANTOMS = [
  /ondertitel(d|ing)/i,
  /amara\.org/i,
  /bedankt voor het kijken/i,
  /thanks? (you )?for watching/i,
  /^\W*(you|bye|\.+)\W*$/i,
]

export function cleanTranscript(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return PHANTOMS.some((p) => p.test(t)) ? '' : t
}

/** 'nl-NL' → 'nl', the form Whisper takes. */
export const whisperLanguage = (tag) => String(tag || 'nl').toLowerCase().split(/[-_]/)[0]

// One transcription at a time: it is CPU-bound, and two at once only makes
// both slower.
let queue = Promise.resolve()

/** @param {Float32Array} samples mono PCM at 16 kHz */
export async function transcribe(samples, language) {
  const asr = await loadWhisper()
  const run = queue.then(() =>
    asr(samples, {
      language: whisperLanguage(language),
      task: 'transcribe',
      chunk_length_s: 30,
    }),
  )
  queue = run.catch(() => {})
  const out = await run
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out?.text
  return cleanTranscript(text)
}
