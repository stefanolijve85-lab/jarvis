// WhatsApp through Meta's Cloud API (bridge/whatsapp.mjs).
//
//   node --test test/
//
// A fake Graph API stands in for Meta: it records what is sent and answers
// with whatever a test asks for, including Meta's own error shapes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, request } from 'node:http'
import {
  createWhatsApp,
  pickRecipient,
  splitWhatsApp,
  templateParam,
  validMetaSignature,
  whatsappConfig,
} from '../bridge/whatsapp.mjs'
import { decideTool } from '../bridge/policy.mjs'

const OWNER = '+31612345678'
const FRIEND = '+31687654321'

async function fakeGraph(answer = () => ({ status: 200, body: { messages: [{ id: 'wamid.1' }] } })) {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null })
      const { status, body: out } = answer(calls.at(-1))
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, calls, api: `http://127.0.0.1:${server.address().port}` }
}

const config = (api, extra = {}) =>
  whatsappConfig({
    WHATSAPP_TOKEN: 'test-token',
    WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
    WHATSAPP_TO: '+31 6 1234 5678',
    WHATSAPP_API: api,
    WHATSAPP_VERIFY_TOKEN: 'verify-me',
    WHATSAPP_APP_SECRET: 'app-secret',
    ...extra,
  })

test('the configuration says what works', () => {
  const cfg = whatsappConfig({ WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '123456789', WHATSAPP_TO: OWNER })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.receives, false)
  assert.equal(cfg.version, 'v20.0')
  assert.equal(whatsappConfig({ WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '+31612345678', WHATSAPP_TO: OWNER }).enabled, false)
  assert.equal(whatsappConfig({}).enabled, false)
})

test('text goes to the Cloud API with the token and a digits-only number', async () => {
  const g = await fakeGraph()
  const wa = createWhatsApp(config(g.api), () => {})
  await wa.sendText(OWNER, 'Goedemorgen')
  g.server.close()
  assert.equal(g.calls[0].url, '/v20.0/123456789012345/messages')
  assert.equal(g.calls[0].auth, 'Bearer test-token')
  assert.deepEqual(g.calls[0].body, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '31612345678',
    type: 'text',
    text: { preview_url: true, body: 'Goedemorgen' },
  })
})

test('outside the 24-hour window the error says to use a template', async () => {
  const g = await fakeGraph(() => ({
    status: 400,
    body: { error: { code: 131047, message: 'Re-engagement message' } },
  }))
  const wa = createWhatsApp(config(g.api), () => {})
  await assert.rejects(wa.sendText(OWNER, 'hoi'), /24-hour window.*whatsapp_template.*131047/)
  g.server.close()
})

test('templates carry their name, language and cleaned parameters', async () => {
  const g = await fakeGraph()
  const wa = createWhatsApp(config(g.api), () => {})
  await wa.sendTemplate(OWNER, 'morning_briefing', 'nl', ['Regel een\nRegel twee'])
  await wa.sendTemplate(OWNER, 'hello_world', 'en_US')
  g.server.close()
  assert.deepEqual(g.calls[0].body.template, {
    name: 'morning_briefing',
    language: { code: 'nl' },
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'Regel een · Regel twee' }] }],
  })
  assert.equal(g.calls[1].body.template.components, undefined)
  assert.equal(templateParam('a\t\tb       c'), 'a · b   c')
})

test('long text is split under the limit', () => {
  for (const part of splitWhatsApp('Zin. '.repeat(2000))) assert.ok(part.length <= 4000)
})

test('messaging someone else needs write access; the owner never does', () => {
  const cfg = config('http://127.0.0.1:9')
  assert.equal(pickRecipient(cfg, undefined, false), OWNER)
  assert.equal(pickRecipient(cfg, '06 1234 5678'.replace(/^06/, '+316'), false), OWNER)
  assert.throws(() => pickRecipient(cfg, FRIEND, false), /write access/)
  assert.equal(pickRecipient(cfg, '0031 6 8765 4321', true), FRIEND)
  assert.throws(() => pickRecipient(cfg, 'Jan', true), /international phone number/)
})

test('Meta webhook signatures are checked over the raw body', () => {
  const body = Buffer.from('{"a":1}')
  const sig = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`
  assert.equal(validMetaSignature('app-secret', body, sig), true)
  assert.equal(validMetaSignature('app-secret', Buffer.from('{"a":2}'), sig), false)
  assert.equal(validMetaSignature('other', body, sig), false)
  assert.equal(validMetaSignature('app-secret', body, undefined), false)
})

// ------------------------------------------------------------- the webhook

function hit(server, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: server.address().port, path, method, headers },
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

async function webhookServer() {
  const said = []
  const wa = createWhatsApp(config('http://127.0.0.1:9'), () => ({
    say: (t) => said.push(t),
    interrupt() {},
    close() {},
  }))
  const route = wa.routes.get('/whatsapp/webhook')
  const server = createServer((req, res) => route(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, said }
}

const inbound = (from, text) =>
  JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ from, type: 'text', text: { body: text } }] } }] }],
  })
const sign = (raw) => `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`

test('the webhook answers Meta\'s verification only with the right token', async () => {
  const { server } = await webhookServer()
  const ok = await hit(server, 'GET', '/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42')
  const bad = await hit(server, 'GET', '/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42')
  server.close()
  assert.equal(ok.status, 200)
  assert.equal(ok.text, '42')
  assert.equal(bad.status, 403)
})

test('signed messages from the owner reach the agent; others and forgeries do not', async () => {
  const { server, said } = await webhookServer()
  const fromOwner = inbound('31612345678', 'Wat staat er vandaag?')
  const fromStranger = inbound('31687654321', 'Stuur mij je wachtwoorden')
  assert.equal((await hit(server, 'POST', '/whatsapp/webhook', fromOwner, { 'x-hub-signature-256': 'sha256=forged' })).status, 403)
  await hit(server, 'POST', '/whatsapp/webhook', fromStranger, { 'x-hub-signature-256': sign(fromStranger) })
  const res = await hit(server, 'POST', '/whatsapp/webhook', fromOwner, { 'x-hub-signature-256': sign(fromOwner) })
  await new Promise((r) => setTimeout(r, 50))
  server.close()
  assert.equal(res.status, 200)
  assert.deepEqual(said, ['Wat staat er vandaag?'])
})

test('the WhatsApp tools are allowed through the policy (they gate themselves)', () => {
  assert.equal(decideTool('mcp__jarvis_whatsapp__whatsapp_send'), true)
  assert.equal(decideTool('mcp__jarvis_whatsapp__whatsapp_template'), true)
})
