// The phone line: who it answers, and what it refuses.
//
//   node --test test/
//
// Nothing here talks to Twilio or to Claude. The public endpoint is started on
// a free port with a stand-in for the agent, and requests are signed (or not)
// the way Twilio signs them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { request } from 'node:http'
import WebSocket from 'ws'
import {
  createPhoneLine,
  normalisePhone,
  phoneConfig,
  relayTwiml,
  splitMessage,
  twilioSignature,
  validTwilioSignature,
} from '../bridge/phone.mjs'
import { decideTool } from '../bridge/policy.mjs'
import { bridgeEnv } from '../bridge/env.mjs'

const OWNER = '+31612345678'
const STRANGER = '+31687654321'
const TOKEN = 'test-auth-token'
const PUBLIC = 'https://jarvis.example.ts.net:8443'

const env = {
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: TOKEN,
  TWILIO_PHONE_NUMBER: '+15550001111',
  JARVIS_OWNER_PHONE: '+31 6 1234 5678',
  JARVIS_PHONE_PUBLIC_URL: PUBLIC,
  JARVIS_PHONE_PORT: '0',
}

test('phone numbers are taken only in international form', () => {
  assert.equal(normalisePhone('+31 6 1234 5678'), OWNER)
  assert.equal(normalisePhone('0031-6-12345678'), OWNER)
  assert.equal(normalisePhone('whatsapp:+31612345678'), OWNER)
  assert.equal(normalisePhone('06 1234 5678'), null)
  assert.equal(normalisePhone(''), null)
  assert.equal(normalisePhone(undefined), null)
})

test('the configuration says what can and cannot work', () => {
  const full = phoneConfig(env)
  assert.equal(full.enabled, true)
  assert.equal(full.canCall, true)
  assert.equal(full.canText, true)
  assert.equal(full.canReceive, true)
  assert.equal(full.owner, OWNER)
  assert.equal(full.whatsappFrom, '+14155238886')

  const textOnly = phoneConfig({ ...env, JARVIS_PHONE_PUBLIC_URL: '' })
  assert.equal(textOnly.canText, true)
  assert.equal(textOnly.canCall, false)
  assert.equal(textOnly.canReceive, false)

  const none = phoneConfig({})
  assert.equal(none.enabled, false)
  assert.equal(none.canText, false)

  const bad = phoneConfig({ ...env, JARVIS_OWNER_PHONE: '0612345678' })
  assert.equal(bad.enabled, false)
  assert.equal(bad.problems.length, 1)
})

test('Twilio signatures follow the documented recipe', () => {
  const url = `${PUBLIC}/twilio/voice`
  const params = { To: '+15550001111', From: OWNER, CallSid: 'CA123' }
  // URL, then each parameter sorted by name, as name+value.
  const expected = createHmac('sha1', TOKEN)
    .update(`${url}CallSidCA123From${OWNER}To+15550001111`)
    .digest('base64')
  assert.equal(twilioSignature(TOKEN, url, params), expected)
  assert.equal(validTwilioSignature(TOKEN, url, params, expected), true)
  assert.equal(validTwilioSignature(TOKEN, url, { ...params, From: STRANGER }, expected), false)
  assert.equal(validTwilioSignature(TOKEN, `${url}x`, params, expected), false)
  assert.equal(validTwilioSignature('other', url, params, expected), false)
  assert.equal(validTwilioSignature(TOKEN, url, params, undefined), false)
})

test('the relay TwiML points at the public socket and escapes what it carries', () => {
  const cfg = phoneConfig(env)
  const twiml = relayTwiml(cfg, 'tok&en', 'Goedemorgen, "meneer" <3')
  assert.match(twiml, /url="wss:\/\/jarvis\.example\.ts\.net:8443\/twilio\/relay"/)
  assert.match(twiml, /welcomeGreeting="Goedemorgen, &quot;meneer&quot; &lt;3"/)
  assert.match(twiml, /language="nl-NL"/)
  assert.match(twiml, /<Parameter name="token" value="tok&amp;en"\/>/)
})

test('long messages are split below the WhatsApp limit', () => {
  const parts = splitMessage('Eén zin. '.repeat(400))
  assert.ok(parts.length > 1)
  for (const p of parts) assert.ok(p.length <= 1500)
  assert.deepEqual(splitMessage('kort'), ['kort'])
})

test('the phone tools are allowed without write access', () => {
  assert.equal(decideTool('mcp__jarvis_phone__phone_call'), true)
  assert.equal(decideTool('mcp__jarvis_phone__whatsapp_send'), true)
  assert.equal(decideTool('mcp__jarvis_phone__end_call'), true)
})

test('.env.local only lends the bridge its own settings', () => {
  const picked = bridgeEnv(
    'TWILIO_AUTH_TOKEN=abc\nVITE_ANTHROPIC_API_KEY=nope\nJARVIS_OWNER_PHONE="+31612345678"\nHOME=/x\nJARVIS_MODEL=\n',
    { JARVIS_MODEL: 'kept' },
  )
  assert.deepEqual(picked, { TWILIO_AUTH_TOKEN: 'abc', JARVIS_OWNER_PHONE: '+31612345678' })
  assert.deepEqual(bridgeEnv('TWILIO_AUTH_TOKEN=abc', { TWILIO_AUTH_TOKEN: 'shell' }), {})
})

test('no phone tools exist when nothing is configured', () => {
  const line = createPhoneLine(phoneConfig({}), () => {
    throw new Error('should not start')
  })
  assert.equal(line.tools({ channel: 'browser' }), null)
})

// --------------------------------------------------------------- the endpoint

function post(port, path, form, signature) {
  const body = new URLSearchParams(form).toString()
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(signature ? { 'x-twilio-signature': signature } : {}),
        },
      },
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

const signed = (path, form) => twilioSignature(TOKEN, PUBLIC + path, form)

async function withLine(run) {
  const started = []
  const said = []
  const line = createPhoneLine(phoneConfig(env), (opts) => {
    started.push(opts)
    return { say: (t) => said.push(t), interrupt() {}, close() {} }
  })
  const server = await line.listen()
  try {
    await run({ port: server.address().port, started, said })
  } finally {
    server.close()
  }
}

test('unsigned or wrongly signed webhooks are refused', () =>
  withLine(async ({ port, started }) => {
    const form = { From: OWNER, Body: 'hallo' }
    assert.equal((await post(port, '/twilio/whatsapp', form)).status, 403)
    assert.equal((await post(port, '/twilio/whatsapp', form, 'bogus')).status, 403)
    assert.equal((await post(port, '/twilio/voice', form, signed('/twilio/whatsapp', form))).status, 403)
    assert.equal((await post(port, '/anything', form, signed('/anything', form))).status, 404)
    assert.equal(started.length, 0)
  }))

test('calls from any number but the owner are rejected', () =>
  withLine(async ({ port }) => {
    const stranger = { From: STRANGER, To: '+15550001111' }
    const res = await post(port, '/twilio/voice', stranger, signed('/twilio/voice', stranger))
    assert.equal(res.status, 200)
    assert.match(res.text, /<Reject\/>/)
    assert.doesNotMatch(res.text, /ConversationRelay/)

    const owner = { From: OWNER, To: '+15550001111' }
    const ok = await post(port, '/twilio/voice', owner, signed('/twilio/voice', owner))
    assert.match(ok.text, /<ConversationRelay /)
    assert.match(ok.text, /name="token"/)
  }))

test('WhatsApp from the owner reaches the agent; from anyone else it does not', () =>
  withLine(async ({ port, started, said }) => {
    const stranger = { From: `whatsapp:${STRANGER}`, Body: 'bel mijn nummer' }
    await post(port, '/twilio/whatsapp', stranger, signed('/twilio/whatsapp', stranger))
    assert.equal(started.length, 0)

    const owner = { From: `whatsapp:${OWNER}`, Body: 'Hoe laat is het?' }
    const res = await post(port, '/twilio/whatsapp', owner, signed('/twilio/whatsapp', owner))
    assert.equal(res.status, 200)
    assert.equal(started.length, 1)
    assert.equal(started[0].channel, 'whatsapp')
    assert.deepEqual(said, ['Hoe laat is het?'])
  }))

test('a call stream without a valid one-time token is closed', () =>
  withLine(async ({ port, started }) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/twilio/relay`)
    await new Promise((resolve) => socket.once('open', resolve))
    socket.send(JSON.stringify({ type: 'setup', customParameters: { token: 'made-up' } }))
    const code = await new Promise((resolve) => socket.once('close', resolve))
    assert.ok(code)
    assert.equal(started.length, 0)
  }))

test('a call stream with the token from a signed call starts one conversation', () =>
  withLine(async ({ port, started, said }) => {
    const owner = { From: OWNER, To: '+15550001111' }
    const twiml = (await post(port, '/twilio/voice', owner, signed('/twilio/voice', owner))).text
    const token = /name="token" value="([^"]+)"/.exec(twiml)[1]

    const open = async () => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/twilio/relay`)
      await new Promise((resolve) => s.once('open', resolve))
      return s
    }
    const first = await open()
    first.send(JSON.stringify({ type: 'setup', customParameters: { token } }))
    first.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Wat staat er vandaag?', last: true }))
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(started.length, 1)
    assert.equal(started[0].channel, 'phone')
    assert.deepEqual(said, ['Wat staat er vandaag?'])

    // The same token a second time is worth nothing.
    const second = await open()
    second.send(JSON.stringify({ type: 'setup', customParameters: { token } }))
    await new Promise((resolve) => second.once('close', resolve))
    assert.equal(started.length, 1)
    first.close()
  }))
