/**
 * WhatsApp through Meta's own Cloud API — no Twilio in between.
 *
 * Your own WhatsApp Business number, registered in Meta Business Manager, so
 * the name and picture people see are yours. JARVIS can message you, and — in
 * your name, after you have said yes — other people.
 *
 *   send       POST https://graph.facebook.com/{version}/{PHONE_NUMBER_ID}/messages
 *   receive    a webhook on the phone line's public endpoint: /whatsapp/webhook
 *
 * WhatsApp's own rule shapes everything here: free-form text reaches someone
 * only within 24 hours of the last message THEY sent. Outside that window only
 * an approved template can start the conversation. Sending text outside the
 * window fails with error 131047, and the agent is told so in plain words and
 * pointed at `whatsapp_template`.
 *
 *   WHATSAPP_TOKEN            a permanent (system user) access token
 *   WHATSAPP_PHONE_NUMBER_ID  the id of your number in Meta, not the number
 *   WHATSAPP_TO               your own number; the default recipient
 *   WHATSAPP_API_VERSION      Graph API version, default v20.0
 *   WHATSAPP_VERIFY_TOKEN     any secret string, also entered in Meta's webhook form
 *   WHATSAPP_APP_SECRET       the Meta app's secret, to check each webhook's signature
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { normalisePhone } from './phone.mjs'

export function whatsappConfig(env = process.env) {
  const token = env.WHATSAPP_TOKEN?.trim() || ''
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim() || ''
  const owner = normalisePhone(env.WHATSAPP_TO ?? env.JARVIS_OWNER_PHONE ?? '')
  const problems = []
  if (phoneNumberId && !/^\d{6,20}$/.test(phoneNumberId)) {
    problems.push('WHATSAPP_PHONE_NUMBER_ID is the numeric id from Meta, not the phone number')
  }
  if (token && !owner) problems.push('set WHATSAPP_TO to your own number, e.g. +31612345678')
  return {
    token,
    phoneNumberId,
    owner,
    version: env.WHATSAPP_API_VERSION?.trim() || 'v20.0',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN?.trim() || '',
    appSecret: env.WHATSAPP_APP_SECRET?.trim() || '',
    api: (env.WHATSAPP_API ?? 'https://graph.facebook.com').replace(/\/+$/, ''),
    enabled: Boolean(token && /^\d{6,20}$/.test(phoneNumberId) && owner),
    receives: Boolean(token && env.WHATSAPP_VERIFY_TOKEN && env.WHATSAPP_APP_SECRET),
    problems,
  }
}

/** E.164 for people, digits only for the API. */
const apiNumber = (e164) => e164.replace(/^\+/, '')

/**
 * The Graph API's errors, in words the agent can act on — and repeat to you.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const EXPLAIN = {
  131047:
    'outside the 24-hour window: they have not messaged this number in the last 24 hours, so only an approved template can reach them — use whatsapp_template',
  131026: 'undeliverable: the number is not on WhatsApp, or cannot receive this message',
  131030: 'that number is not on the test recipient list in Meta (a test number can only message numbers added there)',
  131056: 'too many messages to this person in a short time; wait a little',
  131051: 'this kind of message is not supported',
  132000: 'the template got a different number of parameters than it has placeholders',
  132001: 'no approved template with that name exists in that language',
  132005: 'the filled-in template text is too long',
  132012: 'a template parameter is in the wrong format',
  133010: 'the business number is not registered with the Cloud API yet',
  190: 'the access token is invalid or expired — make a new one in Meta',
  10: 'the token lacks the whatsapp_business_messaging permission',
  100: 'Meta rejected a parameter',
  4: 'the hourly limit of the app was reached',
  80007: 'the rate limit of this WhatsApp account was reached',
}

export class WhatsAppError extends Error {
  constructor(code, detail) {
    super(EXPLAIN[code] ? `${EXPLAIN[code]} (code ${code})` : `${detail || 'WhatsApp refused the message'}${code ? ` (code ${code})` : ''}`)
    this.code = code
  }
}

/** WhatsApp's limit is 4096 characters; split on paragraph, then sentence. */
export function splitWhatsApp(text, max = 4000) {
  const parts = []
  let rest = String(text).trim()
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf('. ', max) + 1
    if (cut < max / 2) cut = max
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

/** Template parameters may not contain newlines, tabs or long runs of spaces. */
export const templateParam = (t) =>
  String(t ?? '')
    .replace(/[\n\t\r]+/g, ' · ')
    .replace(/ {4,}/g, '   ')
    .trim()
    .slice(0, 1024)

/** Checks Meta's X-Hub-Signature-256 over the raw body. */
export function validMetaSignature(appSecret, rawBody, header) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false
  const want = Buffer.from(`sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`)
  const got = Buffer.from(header)
  return want.length === got.length && timingSafeEqual(want, got)
}

const HOUR = 60 * 60 * 1000

/**
 * Who a message may go to: the owner always; anyone else only when the bridge
 * runs with writes on — and then the persona still asks for a yes first.
 */
export function pickRecipient(cfg, to, allowWrites) {
  if (!to) return cfg.owner
  const number = normalisePhone(to)
  if (!number) throw new Error(`"${to}" is not an international phone number like +31612345678`)
  if (number !== cfg.owner && !allowWrites) {
    throw new Error('messaging other people needs write access on the bridge (JARVIS_ALLOW_WRITES=1)')
  }
  return number
}

/**
 * @param cfg       whatsappConfig()
 * @param converse  starts an agent conversation (shared with the phone line)
 * @param opts      { allowWrites, hear(ogg) → text }
 */
export function createWhatsApp(cfg, converse, { allowWrites = false, hear } = {}) {
  /** Who messaged this number, and when: the 24-hour window per person. */
  const lastInbound = new Map()
  const sent = { owner: [], others: [] }

  const allow = (bucket, max) => {
    const now = Date.now()
    sent[bucket] = sent[bucket].filter((t) => now - t < HOUR)
    if (sent[bucket].length >= max) return false
    sent[bucket].push(now)
    return true
  }

  async function graph(body) {
    const res = await fetch(`${cfg.api}/${cfg.version}/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...body }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) {
      const e = data.error ?? {}
      throw new WhatsAppError(e.code, e.error_data?.details || e.message)
    }
    return data.messages?.[0]?.id ?? null
  }

  /** Free-form text — inside the 24-hour window only. */
  async function sendText(to, text) {
    const ids = []
    for (const body of splitWhatsApp(text)) {
      ids.push(await graph({ to: apiNumber(to), type: 'text', text: { preview_url: true, body } }))
    }
    return ids
  }

  /** An approved template — the only way to start a conversation outside the window. */
  async function sendTemplate(to, name, language = 'nl', params = []) {
    const components = params.length
      ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: templateParam(p) })) }]
      : undefined
    return graph({
      to: apiNumber(to),
      type: 'template',
      template: { name, language: { code: language }, ...(components ? { components } : {}) },
    })
  }

  const recipient = (to) => pickRecipient(cfg, to, allowWrites)

  const gate = (number) =>
    number === cfg.owner ? allow('owner', 60) : allow('others', 20)

  // ------------------------------------------------------------- the tools

  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const refuse = (text) => ({ content: [{ type: 'text', text }], isError: true })
  const timers = new Set()

  function later(minutes, run) {
    const delay = Math.min(Math.max(Number(minutes) || 0, 0), 24 * 60)
    if (!delay) return run().then(() => 0)
    if (timers.size >= 20) throw new Error('too many things are already scheduled')
    const timer = setTimeout(() => {
      timers.delete(timer)
      run().catch((err) => console.error(`[jarvis] whatsapp: scheduled message failed — ${err.message}`))
    }, delay * 60 * 1000)
    timer.unref?.()
    timers.add(timer)
    return Promise.resolve(delay)
  }

  const toArg = z
    .string()
    .optional()
    .describe(
      'Recipient in international form (+31612345678). Omit to message the user themselves. ' +
        'Anyone else is messaged in the user\'s name: say who and what first and wait for their yes.',
    )
  const delayArg = z
    .union([z.number(), z.string()])
    .optional()
    .catch(undefined)
    .describe('Wait this many minutes first (max 1440). Omit to send now.')

  function tools({ channel } = {}) {
    const list = [
      tool(
        'whatsapp_send',
        'Send a WhatsApp text from the user\'s own WhatsApp Business number — to the user, or to ' +
          'someone else in their name. Free-form text only reaches people who messaged this ' +
          'number in the last 24 hours; otherwise use whatsapp_template. Before messaging anyone ' +
          'but the user, state the recipient and the exact text and wait for the user\'s yes.' +
          (channel === 'whatsapp' ? ' Your replies in this chat are sent automatically; use this only for someone else or for later.' : ''),
        { text: z.string().min(1).describe('The message.'), to: toArg, delay_minutes: delayArg },
        async (args) => {
          try {
            const number = recipient(args.to)
            const delay = await later(args.delay_minutes, async () => {
              if (!gate(number)) throw new Error('the hourly message limit has been reached')
              await sendText(number, args.text)
            })
            return ok(delay ? `Scheduled in ${delay} minutes (forgotten on restart).` : `Sent to ${number === cfg.owner ? 'the user' : number}.`)
          } catch (err) {
            return refuse(`Not sent: ${err.message}.`)
          }
        },
      ),
      tool(
        'whatsapp_template',
        'Send an approved WhatsApp message template — the only way to reach someone who has not ' +
          'messaged this number in the last 24 hours. Templates are created and approved in Meta ' +
          'Business Manager; give its exact name, its language code, and one value per {{n}} ' +
          'placeholder, in order. Same rule: confirm with the user before messaging anyone else.',
        {
          template: z.string().min(1).describe('The template name, e.g. "hello_world".'),
          language: z.string().optional().describe('Its language code, e.g. "nl" or "en_US". Default nl.'),
          params: z.array(z.string()).optional().describe('Values for the placeholders, in order.'),
          to: toArg,
          delay_minutes: delayArg,
        },
        async (args) => {
          try {
            const number = recipient(args.to)
            const delay = await later(args.delay_minutes, async () => {
              if (!gate(number)) throw new Error('the hourly message limit has been reached')
              await sendTemplate(number, args.template, args.language || 'nl', args.params ?? [])
            })
            return ok(delay ? `Scheduled in ${delay} minutes.` : `Template sent to ${number === cfg.owner ? 'the user' : number}.`)
          } catch (err) {
            return refuse(`Not sent: ${err.message}.`)
          }
        },
      ),
    ]
    return createSdkMcpServer({ name: 'jarvis_whatsapp', version: '1.0.0', tools: list })
  }

  // ----------------------------------------------------------- the webhook

  let chat = null
  let idle = null
  function conversation() {
    clearTimeout(idle)
    idle = setTimeout(() => {
      chat?.close()
      chat = null
    }, 30 * 60 * 1000)
    idle.unref?.()
    chat ??= converse({
      channel: 'whatsapp',
      context: '',
      onText: () => {},
      onDone: (text) => {
        if (text?.trim()) sendText(cfg.owner, text).catch((err) => console.error(`[jarvis] whatsapp: reply failed — ${err.message}`))
      },
      onFail: (message) => void sendText(cfg.owner, message).catch(() => {}),
    })
    return chat
  }

  async function downloadMedia(id) {
    const auth = { authorization: `Bearer ${cfg.token}` }
    const meta = await fetch(`${cfg.api}/${cfg.version}/${id}`, { headers: auth, signal: AbortSignal.timeout(20_000) })
    const { url } = await meta.json()
    if (!url) throw new Error('no media url')
    const file = await fetch(url, { headers: auth, signal: AbortSignal.timeout(30_000) })
    if (!file.ok) throw new Error(`media download failed (${file.status})`)
    return Buffer.from(await file.arrayBuffer())
  }

  async function onMessage(m) {
    const from = normalisePhone(`+${m.from ?? ''}`)
    if (!from) return
    lastInbound.set(from, Date.now())
    // Only the owner talks to JARVIS here. Others opening a window is recorded
    // (so a reply to them can be free text) but never answered by the agent.
    if (from !== cfg.owner) {
      console.log('[jarvis] whatsapp: a message from someone else — not answered')
      return
    }
    let text = m.type === 'text' ? m.text?.body ?? '' : ''
    if ((m.type === 'audio' || m.type === 'voice') && hear) {
      try {
        text = (await hear(await downloadMedia(m.audio?.id ?? m.voice?.id))).trim()
      } catch (err) {
        console.warn(`[jarvis] whatsapp: could not hear a voice message — ${err.message}`)
        await sendText(cfg.owner, 'Ik kon uw spraakbericht niet verstaan.').catch(() => {})
        return
      }
    } else if (m.type !== 'text') {
      text = `[They sent a ${m.type} message, which you cannot open here. Say so if it matters.]`
    }
    if (text.trim()) conversation().say(text.trim())
  }

  async function webhook(req, res) {
    const url = new URL(req.url ?? '/', 'http://x')
    // Meta's one-time check when the webhook is saved.
    if (req.method === 'GET') {
      const okay =
        url.searchParams.get('hub.mode') === 'subscribe' &&
        cfg.verifyToken &&
        url.searchParams.get('hub.verify_token') === cfg.verifyToken
      res.writeHead(okay ? 200 : 403, { 'content-type': 'text/plain' })
      return res.end(okay ? url.searchParams.get('hub.challenge') ?? '' : 'forbidden')
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      return res.end()
    }
    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > 256 * 1024) {
        res.writeHead(413)
        return res.end()
      }
      chunks.push(c)
    }
    const raw = Buffer.concat(chunks)
    if (!validMetaSignature(cfg.appSecret, raw, req.headers['x-hub-signature-256'])) {
      console.warn('[jarvis] whatsapp: refused a webhook with a bad or missing signature')
      res.writeHead(403)
      return res.end()
    }
    // Acknowledge at once; Meta retries anything slow.
    res.writeHead(200)
    res.end()
    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return
    }
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const m of change.value?.messages ?? []) {
          await onMessage(m).catch((err) => console.error(`[jarvis] whatsapp: ${err.message}`))
        }
      }
    }
  }

  return {
    tools,
    sendText,
    sendTemplate,
    routes: cfg.receives ? new Map([['/whatsapp/webhook', webhook]]) : new Map(),
    inWindow: (number) => Date.now() - (lastInbound.get(number) ?? 0) < 24 * HOUR,
  }
}
