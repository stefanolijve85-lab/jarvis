/**
 * JARVIS on the phone: real calls and WhatsApp, through Twilio.
 *
 * Three things live here.
 *
 *   1. Tools for the agent — `phone_call` and `whatsapp_send` — so "call me in
 *      ten minutes" or "send that to my WhatsApp" from the browser does what it
 *      says. Both can only ever reach ONE number, the owner's own
 *      (JARVIS_OWNER_PHONE). There is no argument for a destination, so no page
 *      the agent reads can talk it into phoning or messaging anyone else.
 *
 *   2. A conversation on a call. Twilio's ConversationRelay does the ear and the
 *      mouth — speech to text, text to speech, barge-in — and talks to us over a
 *      WebSocket in plain text. Each call gets its own agent session (Claude
 *      Code, headless, exactly like the browser's), whose words are streamed
 *      back as they are written so speech starts on the first sentence.
 *
 *   3. A conversation on WhatsApp. Messages from the owner arrive as a webhook;
 *      the agent's answer goes back through Twilio's Messages API.
 *
 * Twilio has to reach (2) and (3) from the internet, so they are served by a
 * SEPARATE small HTTP server, on its own port (JARVIS_PHONE_PORT, 8788), that
 * answers nothing else. The main bridge — the one that drives the interface,
 * your files and your browser — stays on loopback. What faces the internet:
 *
 *   POST /twilio/voice     someone rang the Twilio number
 *   POST /twilio/whatsapp  a WhatsApp message arrived
 *   WS   /twilio/relay     the live audio-as-text of a call in progress
 *
 * The two webhooks are refused unless they carry a valid X-Twilio-Signature
 * (an HMAC of the URL and form body, keyed with the auth token only Twilio and
 * this machine know) AND come from the owner's own number. The relay socket
 * does nothing until its first message presents a single-use token that was
 * only ever handed to Twilio inside a signed exchange or an API call.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * A phone number in E.164 (+31612345678), or null.
 *
 * Spaces, dashes, dots and brackets are dropped and a leading 00 becomes +.
 * A national number ("06 1234 5678") is refused rather than guessed at: the
 * country is not knowable from the digits, and a wrong guess dials a stranger.
 */
export function normalisePhone(raw) {
  if (typeof raw !== 'string') return null
  let s = raw.trim().replace(/^whatsapp:/i, '').replace(/[\s\-.()]/g, '')
  if (s.startsWith('00')) s = `+${s.slice(2)}`
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null
}

const SANDBOX_WHATSAPP = '+14155238886'

export function phoneConfig(env = process.env) {
  const sid = env.TWILIO_ACCOUNT_SID?.trim() || ''
  const token = env.TWILIO_AUTH_TOKEN?.trim() || ''
  const owner = normalisePhone(env.JARVIS_OWNER_PHONE ?? '')
  const voiceFrom = normalisePhone(env.TWILIO_PHONE_NUMBER ?? '')
  const whatsappFrom = normalisePhone(env.TWILIO_WHATSAPP_FROM || SANDBOX_WHATSAPP)
  const publicUrl = (env.JARVIS_PHONE_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
  const language = env.JARVIS_PHONE_LANGUAGE?.trim() || 'nl-NL'
  const dutch = language.toLowerCase().startsWith('nl')

  const problems = []
  if (env.JARVIS_OWNER_PHONE && !owner) {
    problems.push('JARVIS_OWNER_PHONE is not an international number like +31612345678')
  }
  if (env.TWILIO_PHONE_NUMBER && !voiceFrom) {
    problems.push('TWILIO_PHONE_NUMBER is not an international number like +15551234567')
  }
  if (publicUrl && !/^https:\/\/[^/]+$/.test(publicUrl)) {
    problems.push('JARVIS_PHONE_PUBLIC_URL must be https://host[:port] with no path')
  }

  const enabled = Boolean(sid && token && owner)
  const reachable = enabled && /^https:\/\/[^/]+$/.test(publicUrl)
  return {
    sid,
    token,
    owner,
    voiceFrom,
    whatsappFrom,
    publicUrl,
    port: Number(env.JARVIS_PHONE_PORT ?? 8788),
    language,
    ttsProvider: env.JARVIS_PHONE_TTS_PROVIDER?.trim() || '',
    voice: env.JARVIS_PHONE_VOICE?.trim() || '',
    greeting:
      env.JARVIS_PHONE_GREETING?.trim() || (dutch ? 'Ja, meneer?' : 'Yes, sir?'),
    enabled,
    // Calling needs a number to call from and a public address for the call
    // to stream to. Messaging out needs only the account.
    canCall: Boolean(reachable && voiceFrom),
    canText: enabled,
    // Anything arriving from Twilio needs the public address.
    canReceive: reachable,
    problems,
  }
}

// ---------------------------------------------------------------------------
// Twilio: signatures, REST, TwiML
// ---------------------------------------------------------------------------

/**
 * Twilio's request signature: HMAC-SHA1 over the full URL followed by every
 * POST parameter, sorted by name, as name+value with no separators; base64.
 */
export function twilioSignature(authToken, url, params = {}) {
  let data = url
  for (const key of Object.keys(params).sort()) data += key + params[key]
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64')
}

export function validTwilioSignature(authToken, url, params, given) {
  if (!authToken || typeof given !== 'string' || !given) return false
  const want = Buffer.from(twilioSignature(authToken, url, params))
  const got = Buffer.from(given)
  return want.length === got.length && timingSafeEqual(want, got)
}

const xml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

/** The TwiML that hands a call to ConversationRelay, carrying a one-time token. */
export function relayTwiml(cfg, token, greeting) {
  const attrs = {
    url: `${cfg.publicUrl.replace(/^https:/, 'wss:')}/twilio/relay`,
    welcomeGreeting: greeting,
    language: cfg.language,
    ...(cfg.ttsProvider ? { ttsProvider: cfg.ttsProvider } : {}),
    ...(cfg.voice ? { voice: cfg.voice } : {}),
  }
  const list = Object.entries(attrs)
    .map(([k, v]) => `${k}="${xml(v)}"`)
    .join(' ')
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response><Connect>' +
    `<ConversationRelay ${list}><Parameter name="token" value="${xml(token)}"/></ConversationRelay>` +
    '</Connect></Response>'
  )
}

async function twilioApi(cfg, path, { method = 'POST', form } = {}) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64')}`,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.message || `Twilio answered ${res.status}`)
  return body
}

/** WhatsApp caps a message at 1600 characters; split on paragraph, then sentence. */
export function splitMessage(text, max = 1500) {
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

// ---------------------------------------------------------------------------
// The phone line
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000

/**
 * A ceiling on what a runaway loop — or a page that talked the agent into
 * something — can cost. Generous for a person, small for a bill.
 */
const LIMITS = { call: 6, message: 40 }

/**
 * Everything phone-related, built once by the bridge.
 *
 * @param cfg        phoneConfig()
 * @param converse   ({ channel, context, onText, onDone, tools }) => conversation
 *                   — starts an agent session; supplied by server.mjs so the
 *                   phone gets the same model, tools and permission gate as the
 *                   browser.
 */
export function createPhoneLine(cfg, converse) {
  const sent = { call: [], message: [] }
  const scheduled = new Map()
  const tokens = new Map()

  const allow = (kind) => {
    const now = Date.now()
    sent[kind] = sent[kind].filter((t) => now - t < HOUR)
    if (sent[kind].length >= LIMITS[kind]) return false
    sent[kind].push(now)
    return true
  }

  /** A single-use pass for one call's relay socket, valid for ten minutes. */
  const issueToken = (call) => {
    const token = randomBytes(24).toString('base64url')
    tokens.set(token, { ...call, expires: Date.now() + 10 * 60 * 1000 })
    for (const [t, v] of tokens) if (v.expires < Date.now()) tokens.delete(t)
    return token
  }
  const takeToken = (token) => {
    const call = typeof token === 'string' ? tokens.get(token) : undefined
    if (!call) return null
    tokens.delete(token)
    return call.expires >= Date.now() ? call : null
  }

  async function sendWhatsApp(text) {
    if (!cfg.canText) throw new Error('WhatsApp is not set up on this machine')
    for (const body of splitMessage(text)) {
      if (!allow('message')) throw new Error('the hourly message limit has been reached')
      await twilioApi(cfg, 'Messages.json', {
        form: { From: `whatsapp:${cfg.whatsappFrom}`, To: `whatsapp:${cfg.owner}`, Body: body },
      })
    }
  }

  async function placeCall({ about, opening }) {
    if (!cfg.canCall) throw new Error('calling is not set up on this machine')
    if (!allow('call')) throw new Error('the hourly call limit has been reached')
    const greeting = opening?.trim() || cfg.greeting
    const token = issueToken({ direction: 'outbound', about, greeting })
    await twilioApi(cfg, 'Calls.json', {
      form: {
        To: cfg.owner,
        From: cfg.voiceFrom,
        Twiml: relayTwiml(cfg, token, greeting),
        Timeout: '30',
      },
    })
  }

  /** Runs now, or after a delay. Timers live in memory: a restart forgets them. */
  function later(minutes, label, run) {
    const delay = Math.min(Math.max(Number(minutes) || 0, 0), 24 * 60)
    if (delay === 0) return run().then(() => null)
    if (scheduled.size >= 20) throw new Error('too many things are already scheduled')
    const id = randomBytes(4).toString('hex')
    const timer = setTimeout(() => {
      scheduled.delete(id)
      run().catch((err) => console.error(`[jarvis] scheduled ${label} failed: ${err.message}`))
    }, delay * 60 * 1000)
    timer.unref?.()
    scheduled.set(id, { label, at: Date.now() + delay * 60 * 1000, timer })
    return Promise.resolve(delay)
  }

  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const refuse = (text) => ({ content: [{ type: 'text', text }], isError: true })

  /**
   * The agent's tools. `channel` says where this agent is talking from, which
   * decides which tools make sense: a call can hang itself up; nobody needs to
   * be phoned by the call they are already on.
   */
  function tools({ channel, endCall } = {}) {
    const list = []

    if (cfg.canCall && channel !== 'phone') {
      list.push(
        tool(
          'phone_call',
          'Ring the user\'s own mobile phone and hold a spoken conversation with them. ' +
            'Only their number can be called — there is no other destination. Use it when ' +
            'they ask you to call them ("bel me", "call me in ten minutes"), or for something ' +
            'they asked to be phoned about. The call is answered by a fresh conversation of ' +
            'yours with NO memory of this one, so `about` must carry everything it needs: ' +
            'why you are calling, the facts, and what they asked for.',
          {
            about: z
              .string()
              .min(1)
              .describe('Briefing for the call: the reason, the facts, what to tell or ask them.'),
            opening: z
              .string()
              .optional()
              .describe('The first sentence you say when they pick up, in their language.'),
            delay_minutes: z
              .union([z.number(), z.string()])
              .optional()
              .catch(undefined)
              .describe('Wait this many minutes before calling (max 1440). Omit to call now.'),
          },
          async (args) => {
            try {
              const delay = await later(args.delay_minutes, 'call', () =>
                placeCall({ about: args.about, opening: args.opening }),
              )
              return ok(
                delay
                  ? `The call is scheduled in ${delay} minutes. It is forgotten if the bridge restarts.`
                  : 'Calling now. Their phone is ringing.',
              )
            } catch (err) {
              return refuse(`The call could not be placed: ${err.message}.`)
            }
          },
        ),
      )
    }

    if (cfg.canText && channel !== 'whatsapp') {
      list.push(
        tool(
          'whatsapp_send',
          'Send the user a WhatsApp message on their own phone. Only their number can be ' +
            'reached. Use it when they ask to be messaged, or to send them something they ' +
            'want to keep: a link, an address, a list, a summary. Plain text; links are fine ' +
            'here because it is read, not spoken.',
          {
            text: z.string().min(1).describe('The message, in their language.'),
            delay_minutes: z
              .union([z.number(), z.string()])
              .optional()
              .catch(undefined)
              .describe('Wait this many minutes before sending (max 1440). Omit to send now.'),
          },
          async (args) => {
            try {
              const delay = await later(args.delay_minutes, 'message', () =>
                sendWhatsApp(args.text),
              )
              return ok(
                delay
                  ? `The message is scheduled in ${delay} minutes. It is forgotten if the bridge restarts.`
                  : 'Sent.',
              )
            } catch (err) {
              return refuse(
                `The message was not sent: ${err.message}. WhatsApp only delivers if the user ` +
                  'has messaged this number in the last twenty-four hours.',
              )
            }
          },
        ),
      )
    }

    if (channel === 'phone' && endCall) {
      list.push(
        tool(
          'end_call',
          'Hang up this call. Use it once the conversation is clearly over — they said ' +
            'goodbye, or said that was all. Say your last line first; it is spoken before ' +
            'the line closes.',
          {},
          async () => {
            endCall()
            return ok('The call will end after your last sentence.')
          },
        ),
      )
    }

    if (!list.length) return null
    return createSdkMcpServer({ name: 'jarvis_phone', version: '1.0.0', tools: list })
  }

  // -------------------------------------------------------------------------
  // The public endpoint Twilio talks to
  // -------------------------------------------------------------------------

  let whatsapp = null
  let whatsappIdle = null

  /** One running WhatsApp conversation, kept for half an hour of quiet. */
  function whatsappConversation() {
    clearTimeout(whatsappIdle)
    whatsappIdle = setTimeout(() => {
      whatsapp?.close()
      whatsapp = null
    }, 30 * 60 * 1000)
    whatsappIdle.unref?.()
    if (whatsapp) return whatsapp
    whatsapp = converse({
      channel: 'whatsapp',
      context: '',
      onText: () => {},
      onDone: (text) => {
        if (text?.trim()) {
          sendWhatsApp(text).catch((err) =>
            console.error(`[jarvis] WhatsApp reply failed: ${err.message}`),
          )
        }
      },
      onFail: (message) => {
        sendWhatsApp(message).catch(() => {})
      },
    })
    return whatsapp
  }

  const readForm = (req) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > 64 * 1024) {
          reject(new Error('too large'))
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () =>
        resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))),
      )
      req.on('error', reject)
    })

  const twiml = (res, body = '<Response/>') => {
    res.writeHead(200, { 'content-type': 'text/xml' })
    res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`)
  }

  async function handle(req, res) {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method !== 'POST' || (path !== '/twilio/voice' && path !== '/twilio/whatsapp')) {
      res.writeHead(404)
      return res.end()
    }
    let form
    try {
      form = await readForm(req)
    } catch {
      res.writeHead(413)
      return res.end()
    }
    // Twilio signs the address it was given, which is the public one — not the
    // loopback address the tunnel delivered the request to.
    const url = cfg.publicUrl + req.url
    if (!validTwilioSignature(cfg.token, url, form, req.headers['x-twilio-signature'])) {
      console.warn(`[jarvis] phone: refused ${path} — bad or missing Twilio signature`)
      res.writeHead(403)
      return res.end()
    }

    if (path === '/twilio/voice') {
      if (normalisePhone(form.From ?? '') !== cfg.owner) {
        console.warn('[jarvis] phone: rejected a call from a number that is not yours')
        return twiml(res, '<Response><Reject/></Response>')
      }
      if (!allow('call')) return twiml(res, '<Response><Reject reason="busy"/></Response>')
      console.log('[jarvis] phone: you are calling — answering')
      const token = issueToken({ direction: 'inbound', about: '', greeting: cfg.greeting })
      return twiml(res, relayTwiml(cfg, token, cfg.greeting).replace(/^<\?xml[^>]*>/, ''))
    }

    // WhatsApp. Answered at once with an empty reply: an agent turn can take
    // longer than Twilio waits for a webhook, so the answer goes out on its own.
    if (normalisePhone(form.From ?? '') !== cfg.owner) {
      console.warn('[jarvis] phone: ignored a WhatsApp message from a number that is not yours')
      return twiml(res)
    }
    twiml(res)
    let text = (form.Body ?? '').trim()
    if (Number(form.NumMedia) > 0) {
      text += `${text ? '\n\n' : ''}[They also sent ${form.NumMedia} attachment(s) — a photo, voice note or file — which you cannot open in this channel. Say so if it matters.]`
    }
    if (!text) return
    console.log('[jarvis] phone: WhatsApp message from you')
    whatsappConversation().say(text)
  }

  /** One live call, between ConversationRelay and an agent session. */
  function relay(socket) {
    let conversation = null
    let hangUp = false
    const send = (msg) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
    }
    // A socket that never introduces itself is not Twilio.
    const deadline = setTimeout(() => socket.close(), 10_000)

    socket.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (msg.type === 'setup') {
        clearTimeout(deadline)
        const call = takeToken(msg.customParameters?.token)
        if (!call || conversation) {
          console.warn('[jarvis] phone: refused a call stream without a valid token')
          return socket.close()
        }
        console.log(`[jarvis] phone: ${call.direction} call connected`)
        const context =
          (call.direction === 'outbound'
            ? `You phoned the user. Why, and what you know:\n${call.about}\n`
            : 'The user phoned you.\n') +
          `You opened the call by saying: "${call.greeting}"`
        conversation = converse({
          channel: 'phone',
          context,
          endCall: () => {
            hangUp = true
          },
          onText: (delta) => send({ type: 'text', token: delta, last: false }),
          onDone: () => {
            send({ type: 'text', token: '', last: true })
            if (hangUp) setTimeout(() => send({ type: 'end' }), 500)
          },
          onFail: (message) => send({ type: 'text', token: message, last: true }),
        })
        return
      }

      if (!conversation) return

      if (msg.type === 'prompt' && msg.last !== false && msg.voicePrompt?.trim()) {
        conversation.say(msg.voicePrompt.trim())
      } else if (msg.type === 'interrupt') {
        conversation.interrupt()
      } else if (msg.type === 'error') {
        console.error(`[jarvis] phone: Twilio reported ${msg.description ?? 'an error'}`)
      }
    })

    socket.on('close', () => {
      clearTimeout(deadline)
      if (conversation) console.log('[jarvis] phone: call ended')
      conversation?.close()
    })
  }

  /** Starts the public endpoint, if there is anything for it to receive. */
  async function listen() {
    if (!cfg.canReceive) return null
    const server = createServer((req, res) => {
      handle(req, res).catch((err) => {
        console.error('[jarvis] phone request failed:', err)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
    const wss = new WebSocketServer({
      server,
      verifyClient: ({ req }, done) =>
        (req.url ?? '').split('?')[0] === '/twilio/relay' ? done(true) : done(false, 404),
    })
    wss.on('connection', relay)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(cfg.port, '127.0.0.1', resolve)
    })
    return server
  }

  /** Points the Twilio number's incoming calls at us, so ringing it reaches JARVIS. */
  async function connectNumber() {
    if (!cfg.canCall) return
    const voiceUrl = `${cfg.publicUrl}/twilio/voice`
    try {
      const found = await twilioApi(
        cfg,
        `IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(cfg.voiceFrom)}`,
        { method: 'GET' },
      )
      const number = found.incoming_phone_numbers?.[0]
      if (!number) {
        console.warn(`[jarvis] phone: ${cfg.voiceFrom} is not a number on this Twilio account`)
        return
      }
      if (number.voice_url === voiceUrl && number.voice_method === 'POST') return
      await twilioApi(cfg, `IncomingPhoneNumbers/${number.sid}.json`, {
        form: { VoiceUrl: voiceUrl, VoiceMethod: 'POST' },
      })
      console.log(`[jarvis] phone: incoming calls on ${cfg.voiceFrom} now reach JARVIS`)
    } catch (err) {
      console.warn(`[jarvis] phone: could not connect ${cfg.voiceFrom} — ${err.message}`)
    }
  }

  return { tools, listen, connectNumber, sendWhatsApp, placeCall }
}

// ---------------------------------------------------------------------------
// A text conversation with the agent
// ---------------------------------------------------------------------------

/**
 * A long-lived agent session fed one message at a time, with its answer
 * streamed out. The browser's session in server.mjs is the same shape with a
 * great deal of interface around it; this is the bare version a phone call and
 * a WhatsApp thread need.
 *
 * Barge-in matters on a call: when the caller talks over JARVIS, Twilio stops
 * the audio, and anything still being written for the abandoned answer must not
 * be spoken afterwards. So an interrupt mutes output until that turn's result
 * arrives, and the next question waits for it.
 */
export function startConversation({ query, options, onText, onDone, onFail }) {
  let deliver = null
  let closed = false
  const inbox = []
  // Turns asked but not yet answered, and how many of those were abandoned:
  // an abandoned turn still ends in a result (an error, since the SDK has no
  // 'cancelled' subtype), and that result and anything before it is swallowed.
  let pending = 0
  let abandoned = 0
  let settled = Promise.resolve()
  let finish = null

  async function* messages() {
    while (!closed) {
      const text =
        inbox.shift() ??
        (await new Promise((resolve) => {
          deliver = resolve
        }))
      if (closed || text == null) return
      pending++
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
    }
  }

  const session = query({ prompt: messages(), options })

  ;(async () => {
    try {
      for await (const msg of session) {
        if (msg.type === 'stream_event') {
          const ev = msg.event
          if (
            abandoned === 0 &&
            ev?.type === 'content_block_delta' &&
            ev.delta?.type === 'text_delta' &&
            ev.delta.text
          ) {
            onText(ev.delta.text)
          }
        } else if (msg.type === 'result') {
          pending = Math.max(0, pending - 1)
          if (abandoned > 0) {
            abandoned--
          } else if (msg.subtype === 'success') {
            onDone(msg.result ?? '')
          } else {
            console.error(`[jarvis] phone turn failed: ${msg.subtype}`)
            onFail('That did not work, I am afraid.')
          }
          finish?.()
          finish = null
        }
      }
    } catch (err) {
      if (!closed) {
        console.error('[jarvis] phone session error:', err)
        onFail('The connection to my systems failed.')
      }
    }
  })()

  return {
    say(text) {
      void settled.then(() => {
        if (closed) return
        if (deliver) {
          const resolve = deliver
          deliver = null
          resolve(text)
        } else inbox.push(text)
      })
    },
    interrupt() {
      // Talking over JARVIS once he has finished writing — he is still being
      // read out — leaves nothing to cancel. Only a turn in flight is abandoned.
      if (pending - abandoned <= 0) return
      abandoned++
      const done = new Promise((resolve) => {
        finish = resolve
      })
      settled = Promise.resolve(session.interrupt?.())
        .catch(() => {})
        .then(() => Promise.race([done, new Promise((r) => setTimeout(r, 1500))]))
    },
    close() {
      closed = true
      deliver?.(null)
      session.close?.()
    },
  }
}
