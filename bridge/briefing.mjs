/**
 * The morning briefing, written by JARVIS himself.
 *
 * GitHub's scheduled workflow can only fetch the weather. JARVIS, on this
 * machine, can read your calendar and mail through your connectors, search the
 * web, look at your shop and payments, and check your sites — so every morning
 * at JARVIS_BRIEFING_TIME (Amsterdam time) he writes the briefing himself and
 * sends it on Telegram, with a button to talk it through, and optionally rings
 * you to read it out.
 *
 * What is facts and what is judgement is kept apart: the weather and whether
 * each site answers are measured here, in code, and handed to him as facts; the
 * agenda, the mail, the ideas and the news are his to gather with his tools.
 *
 *   JARVIS_BRIEFING          off to switch it off (on when Telegram or WhatsApp is set up)
 *   JARVIS_BRIEFING_TIME     08:00 (24h, Europe/Amsterdam)
 *   JARVIS_BRIEFING_SITES    comma-separated URLs to check, e.g. https://solotech.nl
 *   JARVIS_BRIEFING_PLACE    Emmen, with JARVIS_BRIEFING_LAT / _LON for its weather
 *   JARVIS_BRIEFING_CALL     1 to also be phoned with it (needs a Twilio line)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'

const ZONE = 'Europe/Amsterdam'
const STATE = join(homedir(), '.jarvis', 'briefing.json')

export function briefingConfig(env = process.env) {
  const time = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(env.JARVIS_BRIEFING_TIME?.trim() || '08:00')
  return {
    off: env.JARVIS_BRIEFING === 'off',
    hour: time ? Number(time[1]) : 8,
    minute: time ? Number(time[2]) : 0,
    sites: (env.JARVIS_BRIEFING_SITES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\/[^\s]+$/i.test(s)),
    place: env.JARVIS_BRIEFING_PLACE?.trim() || 'Emmen',
    lat: Number(env.JARVIS_BRIEFING_LAT) || 52.78,
    lon: Number(env.JARVIS_BRIEFING_LON) || 6.9,
    call: env.JARVIS_BRIEFING_CALL === '1',
    state: env.JARVIS_BRIEFING_STATE || STATE,
  }
}

/** Today's date and the time, as they are in Amsterdam. */
export function amsterdamNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  )
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  }
}

/**
 * Due now? At or after the set time, at most three hours late (a machine that
 * was off at eight still sends at nine; one switched on in the evening does
 * not send a "morning" briefing), and not already sent today.
 */
export function isDue(cfg, lastDate, now = new Date()) {
  const { date, minutes } = amsterdamNow(now)
  const at = cfg.hour * 60 + cfg.minute
  return lastDate !== date && minutes >= at && minutes < at + 180
}

async function weather(cfg) {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${cfg.lat}&longitude=${cfg.lon}` +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max' +
      `&timezone=${encodeURIComponent(ZONE)}&forecast_days=1`
    const d = (await (await fetch(url, { signal: AbortSignal.timeout(10_000) })).json()).daily
    return (
      `${cfg.place}: ${d.temperature_2m_min[0]}–${d.temperature_2m_max[0]} °C, ` +
      `neerslag ${d.precipitation_sum[0]} mm (kans ${d.precipitation_probability_max[0]}%), ` +
      `wind tot ${d.wind_speed_10m_max[0]} km/u`
    )
  } catch {
    return `${cfg.place}: weerbericht niet beschikbaar`
  }
}

/** Does each site answer, and how fast? Measured, not guessed. */
export async function checkSites(sites) {
  return Promise.all(
    sites.map(async (url) => {
      const started = Date.now()
      try {
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })
        const ms = Date.now() - started
        return `${url}: ${res.ok ? 'online' : `PROBLEEM — status ${res.status}`} (${ms} ms)`
      } catch (err) {
        return `${url}: OFFLINE — ${err.name === 'TimeoutError' ? 'geen antwoord binnen 15 s' : err.message}`
      }
    }),
  )
}

function briefingRequest({ date, weatherLine, siteLines }) {
  return `Maak mijn ochtendbriefing voor vandaag (${date}).

Feiten die al gemeten zijn:
- Weer: ${weatherLine}
${siteLines.length ? `- Sites:\n${siteLines.map((l) => `  - ${l}`).join('\n')}` : '- Sites: (geen opgegeven — gebruik wat je over mijn bedrijven weet)'}

Gebruik je tools om de rest op te halen. Verander, verstuur of plaats niets: alleen lezen.

Schrijf in het Nederlands, kort en scanbaar op een telefoon, met deze kopjes:
1. 📅 Vandaag — mijn afspraken (agenda).
2. 📧 Mail — alleen wat echt aandacht nodig heeft, met wie en waarover.
3. 🌤️ Weer — één regel, met wat het betekent voor de dag.
4. 🏢 Bedrijven — Kwizillo, Detepo, SoloTech: de status van de sites hierboven, en verkopen/betalingen van gisteren als Shopify of Mollie dat laten zien. Noem problemen bovenaan.
5. 💰 Geld verdienen — twee of drie frisse, concrete ideeën die nu werken (zoek actuele trends op), passend bij mijn bedrijven: per idee wat, waarom nu, eerste stap. Herhaal niets uit eerdere briefings.
6. 📰 Nieuws — drie korte punten die voor mij relevant zijn (AI, tech, e-commerce, mijn markten).
7. 🧠 Om over na te denken — één prikkelende gedachte, theorie of inzicht.
8. 💪 Gezondheid — één concrete tip voor vandaag.

Sla een kopje over als er niets is, in plaats van het te vullen. Geen inleiding, geen afsluiting.`
}

/**
 * @param cfg        briefingConfig()
 * @param converse   starts an agent conversation (shared with the phone line)
 * @param deliver    { telegram, whatsapp, call } — whichever exist
 * @param options    { connectorsWarmup } — account connectors join a session
 *                   only from its second message, so a warm-up comes first
 */
export function createBriefing(cfg, converse, deliver, { connectorsWarmup = false } = {}) {
  let running = null
  let timer = null

  const lastSent = () => {
    try {
      return JSON.parse(readFileSync(cfg.state, 'utf8')).date ?? null
    } catch {
      return null
    }
  }
  const markSent = (date) => {
    try {
      mkdirSync(dirname(cfg.state), { recursive: true })
      writeFileSync(cfg.state, JSON.stringify({ date, at: new Date().toISOString() }))
    } catch (err) {
      console.warn(`[jarvis] briefing: could not note it was sent — ${err.message}`)
    }
  }

  /** Writes the briefing with the agent and returns its text. */
  function write(request) {
    return new Promise((resolve, reject) => {
      let turns = 0
      const want = connectorsWarmup ? 2 : 1
      const timeout = setTimeout(() => {
        conversation.close()
        reject(new Error('the briefing took longer than ten minutes'))
      }, 10 * 60 * 1000)
      const conversation = converse({
        channel: 'briefing',
        context: '',
        onText: () => {},
        onDone: (text) => {
          turns++
          if (turns < want) {
            conversation.say(request)
            return
          }
          clearTimeout(timeout)
          conversation.close()
          resolve(String(text ?? '').trim())
        },
        onFail: (message) => {
          clearTimeout(timeout)
          conversation.close()
          reject(new Error(message))
        },
      })
      conversation.say(connectorsWarmup ? 'Goedemorgen. Ik vraag zo mijn ochtendbriefing.' : request)
    })
  }

  /** Builds and sends the briefing now. Shared by the schedule and the tool. */
  async function send({ reason = 'schedule' } = {}) {
    if (running) return running
    running = (async () => {
      const { date } = amsterdamNow()
      console.log(`[jarvis] briefing: writing (${reason})`)
      const [weatherLine, siteLines] = await Promise.all([weather(cfg), checkSites(cfg.sites)])
      const text = await write(briefingRequest({ date, weatherLine, siteLines }))
      if (!text) throw new Error('the briefing came back empty')
      const header = `☀️ Ochtendbriefing — ${date}\n\n`
      let delivered = false
      if (deliver.telegram) {
        const button = deliver.telegram.talkUrl
          ? { reply_markup: { inline_keyboard: [[{ text: '📞 Bespreek met Jarvis', url: deliver.telegram.talkUrl }]] } }
          : {}
        try {
          await deliver.telegram.send(header + text, button)
          delivered = true
        } catch (err) {
          console.warn(`[jarvis] briefing: Telegram — ${err.message}`)
        }
      }
      if (deliver.whatsapp) {
        try {
          await deliver.whatsapp(header + text)
          delivered = true
        } catch (err) {
          console.warn(`[jarvis] briefing: WhatsApp — ${err.message}`)
        }
      }
      if (cfg.call && deliver.call) {
        try {
          await deliver.call(text)
        } catch (err) {
          console.warn(`[jarvis] briefing: call — ${err.message}`)
        }
      }
      if (!delivered) throw new Error('it could not be delivered — is Telegram linked, or WhatsApp set up?')
      markSent(date)
      console.log('[jarvis] briefing: sent')
      return text
    })().finally(() => {
      running = null
    })
    return running
  }

  function start() {
    if (cfg.off || (!deliver.telegram && !deliver.whatsapp)) return false
    const tick = () => {
      if (!running && isDue(cfg, lastSent())) {
        send().catch((err) => console.error(`[jarvis] briefing failed: ${err.message}`))
      }
    }
    timer = setInterval(tick, 30_000)
    timer.unref?.()
    setTimeout(tick, 15_000).unref?.()
    const hh = String(cfg.hour).padStart(2, '0')
    const mm = String(cfg.minute).padStart(2, '0')
    console.log(`[jarvis] briefing: every day at ${hh}:${mm} Amsterdam time${cfg.sites.length ? `, checking ${cfg.sites.length} site(s)` : ''}`)
    return true
  }

  /** "Geef me nu de briefing" — the same briefing, on request. */
  function tools() {
    return createSdkMcpServer({
      name: 'jarvis_briefing',
      version: '1.0.0',
      tools: [
        tool(
          'send_briefing_now',
          'Write and send the morning briefing now — agenda, mail, weather, the ' +
            'businesses, money ideas, news, a thought, a health tip — to their phone, as ' +
            'it goes every morning. Use it when they ask for their briefing. It takes a minute or two.',
          {},
          async () => {
            send({ reason: 'asked' }).catch((err) =>
              console.error(`[jarvis] briefing failed: ${err.message}`),
            )
            return { content: [{ type: 'text', text: 'The briefing is being written and will arrive on their phone in a minute or two.' }] }
          },
        ),
      ],
    })
  }

  return { start, send, tools, stop: () => clearInterval(timer) }
}
