/**
 * JARVIS on Telegram: a bot with his own name, for text and voice messages.
 *
 * Free, permanent and official — no phone provider, no 72-hour sandbox, no
 * approval. And nothing on this machine has to be reachable from the internet:
 * the bridge asks Telegram for new messages (long polling) rather than waiting
 * for Telegram to call in.
 *
 *   text     → the same agent as everywhere else → a text reply
 *   voice    → transcribed here (Whisper; ElevenLabs Scribe as a fallback)
 *            → the agent → a voice reply in his own voice, plus the text
 *
 * Only one person is ever answered: the owner. The bot is linked to you once,
 * by sending it the pairing code the bridge prints in its terminal; that id is
 * kept in ~/.jarvis/telegram.json (or set TELEGRAM_OWNER_ID yourself). Anyone
 * else who finds the bot is ignored.
 *
 * Voice messages need ffmpeg on this machine (sudo apt install ffmpeg), to turn
 * Telegram's Opus audio into samples and his voice back into Opus.
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const STORE = join(homedir(), '.jarvis', 'telegram.json')

export function telegramConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || ''
  const ownerFromEnv = Number(env.TELEGRAM_OWNER_ID)
  return {
    token,
    enabled: /^\d+:[A-Za-z0-9_-]{20,}$/.test(token),
    malformed: Boolean(token) && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token),
    ownerFromEnv: Number.isSafeInteger(ownerFromEnv) && ownerFromEnv > 0 ? ownerFromEnv : null,
    api: (env.TELEGRAM_API ?? 'https://api.telegram.org').replace(/\/+$/, ''),
    store: env.TELEGRAM_STORE || STORE,
    talkUrl: (env.JARVIS_PUBLIC_ORIGIN ?? '').trim().replace(/\/+$/, '')
      ? `${env.JARVIS_PUBLIC_ORIGIN.trim().replace(/\/+$/, '')}/talk`
      : '',
  }
}

/** Telegram allows 4096 characters a message. */
export function splitTelegram(text, max = 4000) {
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

const sameCode = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export const hasFfmpeg = () => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/** Runs ffmpeg over a buffer and returns its output. */
export function ffmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out = []
    let err = ''
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => (err = (err + d).slice(-1000)))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: ${err.trim() || code}`)),
    )
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/**
 * @param cfg        telegramConfig()
 * @param converse   starts an agent conversation (same as the phone line's)
 * @param voice      { hear(ogg) → text, speak(text) → { audio, type } | null }
 */
export function createTelegram(cfg, converse, voice) {
  let owner = cfg.ownerFromEnv
  if (!owner) {
    try {
      owner = JSON.parse(readFileSync(cfg.store, 'utf8')).owner ?? null
    } catch {
      owner = null
    }
  }
  // Six digits, new each start, shown only in the terminal.
  const pairing = String(randomInt(100000, 1000000))
  let botName = ''
  let stopped = false

  async function call(method, body, { form } = {}) {
    const res = await fetch(`${cfg.api}/bot${cfg.token}/${method}`, {
      method: 'POST',
      ...(form
        ? { body: form }
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 70_000 : 30_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!data.ok) throw new Error(data.description || `Telegram answered ${res.status}`)
    return data.result
  }

  async function sendText(text, extra = {}) {
    if (!owner) throw new Error('no Telegram account is linked yet')
    for (const part of splitTelegram(text)) {
      await call('sendMessage', { chat_id: owner, text: part, ...extra })
    }
  }

  async function sendVoiceNote(text) {
    const spoken = await voice.speak(text)
    if (!spoken) return false
    const ogg = await ffmpeg(
      ['-i', 'pipe:0', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1'],
      spoken.audio,
    )
    const form = new FormData()
    form.append('chat_id', String(owner))
    form.append('voice', new Blob([ogg], { type: 'audio/ogg' }), 'jarvis.ogg')
    await call('sendVoice', null, { form })
    return true
  }

  // ------------------------------------------------------------ the agent

  let chat = null
  let idle = null
  /** Whether the message being answered was spoken, so the answer is too. */
  let replyByVoice = false

  function conversation() {
    clearTimeout(idle)
    idle = setTimeout(() => {
      chat?.close()
      chat = null
    }, 30 * 60 * 1000)
    idle.unref?.()
    if (chat) return chat
    chat = converse({
      channel: 'telegram',
      context: '',
      onText: () => {},
      onDone: (text) => void reply(text),
      onFail: (message) => void sendText(message).catch(() => {}),
    })
    return chat
  }

  async function reply(text) {
    if (!text?.trim()) return
    const spoken = replyByVoice
    replyByVoice = false
    try {
      if (spoken && hasFfmpeg()) {
        await call('sendChatAction', { chat_id: owner, action: 'record_voice' }).catch(() => {})
        const sent = await sendVoiceNote(text).catch((err) => {
          console.warn(`[jarvis] telegram: voice reply failed — ${err.message}`)
          return false
        })
        // The words as well, for reading back — and on their own if the voice
        // could not be made.
        await sendText(text, sent ? { disable_notification: true } : {})
      } else {
        await sendText(text)
      }
    } catch (err) {
      console.error(`[jarvis] telegram: reply failed — ${err.message}`)
    }
  }

  async function handle(message) {
    const from = message.from?.id
    const chatId = message.chat?.id
    if (!from || message.chat?.type !== 'private') return

    // Linking: "/start 123456" with the code from the terminal.
    const text = (message.text ?? '').trim()
    if (!owner) {
      const code = /^\/start\s+(\d{6})$/.exec(text)?.[1]
      if (code && sameCode(code, pairing)) {
        owner = from
        try {
          mkdirSync(dirname(cfg.store), { recursive: true })
          writeFileSync(cfg.store, JSON.stringify({ owner }), { mode: 0o600 })
        } catch (err) {
          console.warn(`[jarvis] telegram: could not save the link — ${err.message}`)
        }
        console.log('[jarvis] telegram: linked to your account')
        await call('sendMessage', {
          chat_id: chatId,
          text: 'Gekoppeld. Goedendag, meneer. Stuur me een bericht of een spraakbericht.',
        }).catch(() => {})
      }
      return
    }
    // Everyone but the owner is ignored, without an answer.
    if (from !== owner) return

    if (text === '/start') {
      await sendText('Tot uw dienst, meneer.').catch(() => {})
      return
    }

    let said = text
    if (message.voice || message.audio) {
      const file = message.voice ?? message.audio
      try {
        await call('sendChatAction', { chat_id: owner, action: 'typing' }).catch(() => {})
        const info = await call('getFile', { file_id: file.file_id })
        const res = await fetch(`${cfg.api}/file/bot${cfg.token}/${info.file_path}`, {
          signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) throw new Error(`download failed (${res.status})`)
        said = (await voice.hear(Buffer.from(await res.arrayBuffer()))).trim()
      } catch (err) {
        console.warn(`[jarvis] telegram: could not hear a voice message — ${err.message}`)
        await sendText(
          'Ik kon uw spraakbericht niet verstaan. ' +
            (hasFfmpeg() ? 'Probeert u het nog eens?' : 'Daarvoor moet ffmpeg op de computer staan.'),
        ).catch(() => {})
        return
      }
      if (!said) {
        await sendText('Ik hoorde niets in dat bericht.').catch(() => {})
        return
      }
      replyByVoice = true
    } else if (message.photo || message.document || message.video || message.sticker) {
      said = `${text ? `${text}\n\n` : ''}[They sent a photo, file or sticker, which you cannot open here. Say so if it matters.]`
    }
    if (!said) return

    await call('sendChatAction', { chat_id: owner, action: 'typing' }).catch(() => {})
    conversation().say(said)
  }

  async function poll() {
    let offset = 0
    let delay = 1000
    while (!stopped) {
      try {
        const updates = await call('getUpdates', {
          offset,
          timeout: 50,
          allowed_updates: ['message'],
        })
        delay = 1000
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1)
          if (update.message) {
            await handle(update.message).catch((err) =>
              console.error(`[jarvis] telegram: ${err.message}`),
            )
          }
        }
      } catch (err) {
        if (stopped) return
        if (/unauthorized|not found/i.test(err.message)) {
          console.error('[jarvis] telegram: the bot token was refused — check TELEGRAM_BOT_TOKEN')
          return
        }
        console.warn(`[jarvis] telegram: ${err.message} — retrying`)
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, 60_000)
      }
    }
  }

  // ------------------------------------------------------------ the tools

  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const refuse = (text) => ({ content: [{ type: 'text', text }], isError: true })
  const timers = new Set()

  function later(minutes, run) {
    const delay = Math.min(Math.max(Number(minutes) || 0, 0), 24 * 60)
    if (!delay) return run().then(() => 0)
    if (timers.size >= 20) throw new Error('too many things are already scheduled')
    const timer = setTimeout(() => {
      timers.delete(timer)
      run().catch((err) => console.error(`[jarvis] telegram: scheduled message failed — ${err.message}`))
    }, delay * 60 * 1000)
    timer.unref?.()
    timers.add(timer)
    return Promise.resolve(delay)
  }

  function tools({ channel } = {}) {
    const list = []
    const delayArg = z
      .union([z.number(), z.string()])
      .optional()
      .catch(undefined)
      .describe('Wait this many minutes first (max 1440). Omit to do it now.')

    if (channel !== 'telegram') {
      list.push(
        tool(
          'telegram_send',
          'Send the user a Telegram message on their phone — only ever to them. Use it ' +
            'when they ask to be messaged, or to send something they want to keep: a ' +
            'link, an address, a list, a reminder. Plain text; links are fine.',
          { text: z.string().min(1).describe('The message, in their language.'), delay_minutes: delayArg },
          async (args) => {
            try {
              const delay = await later(args.delay_minutes, () => sendText(args.text))
              return ok(delay ? `Scheduled in ${delay} minutes (forgotten on restart).` : 'Sent.')
            } catch (err) {
              return refuse(`Not sent: ${err.message}.`)
            }
          },
        ),
      )
    }

    if (cfg.talkUrl) {
      list.push(
        tool(
          'call_me',
          'Ask the user to talk: their phone gets a Telegram notification with a button ' +
            'that opens the talk app, where they speak with you out loud. This is how you ' +
            '"call" them. Use it when they ask you to call them, now or later. The talk ' +
            'app starts a fresh conversation with no memory of this one, so put what it ' +
            'is about in `reason` — it is shown to them.',
          {
            reason: z.string().min(1).describe('One line on why, shown in the notification.'),
            delay_minutes: delayArg,
          },
          async (args) => {
            try {
              const run = () =>
                sendText(`📞 ${args.reason}`, {
                  reply_markup: {
                    inline_keyboard: [[{ text: 'Praat met Jarvis', url: cfg.talkUrl }]],
                  },
                })
              const delay = await later(args.delay_minutes, run)
              return ok(delay ? `They will be called in ${delay} minutes.` : 'Their phone has the call.')
            } catch (err) {
              return refuse(`The call could not be placed: ${err.message}.`)
            }
          },
        ),
      )
    }

    if (!owner || !list.length) return null
    return createSdkMcpServer({ name: 'jarvis_telegram', version: '1.0.0', tools: list })
  }

  async function start() {
    try {
      const me = await call('getMe')
      botName = me.username ?? ''
    } catch (err) {
      console.error(`[jarvis] telegram: ${err.message} — check TELEGRAM_BOT_TOKEN`)
      return
    }
    if (owner) {
      console.log(`[jarvis] telegram: @${botName} is listening for you`)
    } else {
      console.log(
        `[jarvis] telegram: link @${botName} to yourself — open it in Telegram and send:  /start ${pairing}`,
      )
    }
    void poll()
  }

  return {
    start,
    stop: () => {
      stopped = true
    },
    tools,
    linked: () => Boolean(owner),
    pairingCode: () => pairing,
  }
}

/** Is a stored link there? For the setup check. */
export const telegramLinked = () => existsSync(STORE)
