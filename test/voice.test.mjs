// JARVIS's voice made on this machine (bridge/voice.mjs) and /speak.
//
//   node --test test/
//
// Piper itself is not downloaded or run here. What is tested is what turns
// its output into a file a phone plays, what gets read aloud, and what /speak
// accepts and refuses.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'
import { programArchive, speakable, wav } from '../bridge/voice.mjs'

test('raw Piper output becomes a valid WAV file', () => {
  const pcm = Buffer.alloc(22050 * 2) // one second of silence
  const file = wav(pcm, 22050)
  assert.equal(file.length, 44 + pcm.length)
  assert.equal(file.toString('ascii', 0, 4), 'RIFF')
  assert.equal(file.readUInt32LE(4), 36 + pcm.length)
  assert.equal(file.toString('ascii', 8, 16), 'WAVEfmt ')
  assert.equal(file.readUInt16LE(20), 1) // PCM
  assert.equal(file.readUInt16LE(22), 1) // mono
  assert.equal(file.readUInt32LE(24), 22050)
  assert.equal(file.readUInt32LE(28), 44100) // bytes per second
  assert.equal(file.readUInt16LE(34), 16)
  assert.equal(file.toString('ascii', 36, 40), 'data')
  assert.equal(file.readUInt32LE(40), pcm.length)
})

test('only words are read aloud', () => {
  assert.equal(speakable('**Goed** nieuws: zie https://example.com/x?y=1 🎉'), 'Goed nieuws: zie')
  assert.equal(speakable('Lees [het artikel](https://example.com) maar'), 'Lees het artikel maar')
  assert.equal(speakable('   '), '')
  assert.equal(speakable('a'.repeat(2000)).length, 800)
})

test('the right Piper build is picked for each computer', () => {
  assert.match(programArchive('linux', 'x64'), /piper_linux_x86_64\.tar\.gz$/)
  assert.match(programArchive('linux', 'arm64'), /piper_linux_aarch64\.tar\.gz$/)
  assert.match(programArchive('darwin', 'arm64'), /piper_macos_aarch64\.tar\.gz$/)
  assert.equal(programArchive('win32', 'x64'), null)
})

// ----------------------------------------------------------------- /speak

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))

function startBridge(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      JARVIS_BRIDGE_PORT: '0',
      JARVIS_WHISPER_PRELOAD: '0',
      JARVIS_PIPER_PRELOAD: '0',
      JARVIS_SKIP_ENV_FILE: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`bridge did not start: ${log}`))
    }, 15_000)
    child.stdout.on('data', (d) => {
      log += d
      const m = /bridge listening on ws:\/\/\S+:(\d+)/.exec(log)
      if (m) {
        clearTimeout(timer)
        resolve({ child, port: Number(m[1]) })
      }
    })
    child.stderr.on('data', (d) => (log += d))
    child.on('exit', (code) => reject(new Error(`bridge exited ${code}: ${log}`)))
  })
}

function post(port, body, headers = {}) {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/speak',
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        timeout: 5000,
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('error', (err) => resolve(err.code))
    req.end(body)
  })
}

let on
let off
before(async () => {
  ;[on, off] = await Promise.all([startBridge(), startBridge({ JARVIS_PIPER: 'off' })])
})
after(() => {
  on?.child.kill()
  off?.child.kill()
})

test('/speak wants {"text": …}', async () => {
  assert.equal(await post(on.port, 'not json'), 400)
})

test('/speak has nothing to say for nothing, without loading the voice', async () => {
  assert.equal(await post(on.port, JSON.stringify({ text: ' **  ' })), 204)
})

test('/speak refuses a novel', async () => {
  const status = await post(on.port, JSON.stringify({ text: 'x'.repeat(40_000) }))
  assert.ok(status === 413 || status === 'ECONNRESET' || status === 'EPIPE', String(status))
})

test('/speak is refused from a page that is not ours', async () => {
  assert.equal(await post(on.port, JSON.stringify({ text: 'hallo' }), { origin: 'https://evil.example' }), 403)
})

test('/speak says so when the voice is switched off', async () => {
  assert.equal(await post(off.port, JSON.stringify({ text: 'hallo' })), 503)
})
