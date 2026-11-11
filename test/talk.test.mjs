// The talk app's side of the bridge: /listen and the ?mode=talk socket.
//
//   node --test test/
//
// Whisper itself is not loaded here — it is a few hundred MB from the network.
// What is tested is everything around it: what /listen accepts and refuses,
// and that the talk socket is let in on the same terms as the interface.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { cleanTranscript, whisperLanguage } from '../bridge/whisper.mjs'

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

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers, timeout: 5000 },
      (res) => {
        let text = ''
        res.on('data', (d) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode, text }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

const pcm = (seconds) => Buffer.from(new Float32Array(Math.round(16_000 * seconds)).buffer)
const octet = { 'content-type': 'application/octet-stream' }

let on
let off
before(async () => {
  ;[on, off] = await Promise.all([startBridge(), startBridge({ JARVIS_WHISPER: 'off' })])
})
after(() => {
  on?.child.kill()
  off?.child.kill()
})

test('/listen takes only raw float samples', async () => {
  assert.equal((await post(on.port, '/listen', pcm(1), { 'content-type': 'audio/webm' })).status, 415)
  assert.equal((await post(on.port, '/listen', Buffer.alloc(4001), octet)).status, 400)
})

test('/listen answers a tap with nothing, without loading anything', async () => {
  const res = await post(on.port, '/listen', pcm(0.2), octet)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.text), { text: '' })
})

test('/listen refuses a recording over a minute', async () => {
  const res = await post(on.port, '/listen', pcm(61), octet).catch((err) => ({ status: err.code }))
  // Either a 413, or the socket closed under a body that kept coming.
  assert.ok(res.status === 413 || res.status === 'ECONNRESET' || res.status === 'EPIPE', String(res.status))
})

test('/listen is refused from a page that is not ours', async () => {
  const res = await post(on.port, '/listen', pcm(1), { ...octet, origin: 'https://evil.example' })
  assert.equal(res.status, 403)
})

test('/listen says so when speech recognition is switched off', async () => {
  const res = await post(off.port, '/listen', pcm(1), octet)
  assert.equal(res.status, 503)
})

test('/health tells the talk app what it can do', async () => {
  const body = await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: on.port, path: '/health' }, (res) => {
      let text = ''
      res.on('data', (d) => (text += d))
      res.on('end', () => resolve(JSON.parse(text)))
    })
      .on('error', reject)
      .end()
  })
  assert.equal(body.listen, true)
  assert.equal(body.listenState, 'idle')
  assert.equal(body.language, 'nl-NL')
})

test('the talk socket is let in from our own page and not from others', async () => {
  const open = (origin) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${on.port}/ws?mode=talk`, { origin })
      ws.once('message', (m) => {
        resolve(JSON.parse(String(m)).type)
        ws.close()
      })
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode))
      ws.once('error', () => resolve('error'))
    })
  assert.equal(await open('http://localhost:5173'), 'ready')
  assert.equal(await open('https://evil.example'), 403)
})

test('Whisper phantoms are dropped and real words kept', () => {
  assert.equal(cleanTranscript(' Ondertiteling door de Amara.org gemeenschap '), '')
  assert.equal(cleanTranscript('Bedankt voor het kijken!'), '')
  assert.equal(cleanTranscript('  Hoe   laat is het?  '), 'Hoe laat is het?')
  assert.equal(whisperLanguage('nl-NL'), 'nl')
  assert.equal(whisperLanguage('en_GB'), 'en')
})
