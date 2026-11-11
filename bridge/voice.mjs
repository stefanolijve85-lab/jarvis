/**
 * JARVIS's voice, made on this machine: Piper text-to-speech.
 *
 * The talk app used to rely on the phone's own speech synthesis, and on an
 * iPhone in Chrome that simply does not work — the diagnostics report the
 * synthesiser as down while ordinary audio plays fine. So the voice is made
 * here instead and sent as a WAV file, which every phone plays.
 *
 * Piper (github.com/rhasspy/piper) is a small offline speech engine with good
 * Dutch voices. On first start the bridge downloads the program and one voice
 * into ~/.jarvis/piper — about 80 MB — and from then on everything is local:
 * no account, no key, no cost per word.
 *
 *   JARVIS_PIPER_VOICE  which voice (default nl-rdh-medium, a Dutch male voice;
 *                       also nl-nathalie-x-low, nl-mls_5809-low, …)
 *   JARVIS_PIPER_MODEL  an .onnx voice file you downloaded yourself, instead
 *   JARVIS_PIPER=off    switch it off; the talk app falls back to the phone
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ROOT = join(homedir(), '.jarvis', 'piper')
const RELEASE = 'https://github.com/rhasspy/piper/releases/download'
const PROGRAM_TAG = '2023.11.14-2'
const VOICES_TAG = 'v0.0.2'

export const PIPER_VOICE = process.env.JARVIS_PIPER_VOICE?.trim() || 'nl-rdh-medium'
export const piperEnabled = () => process.env.JARVIS_PIPER !== 'off'

/** The release archive for this computer, or null where Piper has none. */
export function programArchive(platform = process.platform, arch = process.arch) {
  const name = {
    'linux-x64': 'piper_linux_x86_64',
    'linux-arm64': 'piper_linux_aarch64',
    'linux-arm': 'piper_linux_armv7l',
    'darwin-x64': 'piper_macos_x64',
    'darwin-arm64': 'piper_macos_aarch64',
  }[`${platform}-${arch}`]
  return name ? `${RELEASE}/${PROGRAM_TAG}/${name}.tar.gz` : null
}

const PROGRAM = join(ROOT, 'piper', 'piper')
const VOICE_DIR = join(ROOT, 'voices', PIPER_VOICE)

async function download(url, file) {
  mkdirSync(dirname(file), { recursive: true })
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) })
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file))
}

function untar(file, into) {
  mkdirSync(into, { recursive: true })
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', file, '-C', into], { stdio: 'ignore' })
    tar.on('error', reject)
    tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))))
  })
}

function findModel() {
  const own = process.env.JARVIS_PIPER_MODEL?.trim()
  if (own) return existsSync(own) ? own : null
  if (!existsSync(VOICE_DIR)) return null
  const onnx = readdirSync(VOICE_DIR).find((f) => f.endsWith('.onnx'))
  return onnx ? join(VOICE_DIR, onnx) : null
}

let ready = null
let state = 'idle'
let model = null
let sampleRate = 22050

/** 'off', 'idle', 'loading', 'ready' or 'failed'. */
export const voiceState = () => (piperEnabled() ? state : 'off')

/** Downloads Piper and the voice if they are not here yet. Shared promise. */
export function loadVoice() {
  if (!piperEnabled()) return Promise.reject(new Error('the voice is switched off'))
  ready ??= (async () => {
    state = 'loading'
    if (!existsSync(PROGRAM)) {
      const url = programArchive()
      if (!url) throw new Error(`Piper has no build for ${process.platform}-${process.arch}`)
      console.log('[jarvis] downloading the voice engine (Piper)…')
      const file = join(ROOT, 'piper.tar.gz')
      await download(url, file)
      await untar(file, ROOT)
      rmSync(file, { force: true })
    }
    model = findModel()
    if (!model) {
      if (process.env.JARVIS_PIPER_MODEL) {
        throw new Error(`JARVIS_PIPER_MODEL ${process.env.JARVIS_PIPER_MODEL} does not exist`)
      }
      console.log(`[jarvis] downloading the voice ${PIPER_VOICE}…`)
      const file = join(ROOT, `${PIPER_VOICE}.tar.gz`)
      await download(`${RELEASE}/${VOICES_TAG}/voice-${PIPER_VOICE}.tar.gz`, file)
      await untar(file, VOICE_DIR)
      rmSync(file, { force: true })
      model = findModel()
      if (!model) throw new Error(`the ${PIPER_VOICE} download held no voice`)
    }
    try {
      const config = JSON.parse(readFileSync(`${model}.json`, 'utf8'))
      sampleRate = Number(config?.audio?.sample_rate) || 22050
    } catch {
      /* keep the default */
    }
    // One short sentence proves the program runs on this machine at all.
    await synthesizeRaw('Klaar.')
    state = 'ready'
    console.log(`[jarvis] voice ready — Piper, ${PIPER_VOICE}`)
  })().catch((err) => {
    ready = null
    state = 'failed'
    throw err
  })
  return ready
}

/**
 * Text as it should be read: no markdown, no URLs, no emoji, nothing a
 * speech engine would spell out.
 */
export function speakable(text) {
  return String(text ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>|~]+/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800)
}

function synthesizeRaw(text) {
  return new Promise((resolve, reject) => {
    const dir = dirname(PROGRAM)
    const child = spawn(PROGRAM, ['--model', model, '--output_raw'], {
      cwd: dir,
      env: {
        ...process.env,
        // The release ships its own libraries beside the program.
        LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
        DYLD_LIBRARY_PATH: [dir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out = []
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('the voice took too long'))
    }, 30_000)
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(`Piper exited ${code}: ${err.trim().split('\n').pop() ?? ''}`))
    })
    child.stdin.end(`${text}\n`)
  })
}

/** 16-bit mono PCM, wrapped in the 44 bytes that make it a WAV file. */
export function wav(pcm, rate) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // mono
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

// Two at a time: the next sentence is being made while this one plays.
let running = 0
const waiting = []
async function slot(run) {
  if (running >= 2) await new Promise((resolve) => waiting.push(resolve))
  running++
  try {
    return await run()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/** Returns a WAV file of `text` spoken, or null when there is nothing to say. */
export async function speak(text) {
  const line = speakable(text)
  if (!line) return null
  await loadVoice()
  const pcm = await slot(() => synthesizeRaw(line))
  return wav(pcm, sampleRate)
}
