/**
 * Bridge settings from `.env.local`.
 *
 * The bridge has always read its settings from the shell, which is fine for one
 * flag and miserable for the five a phone line needs — an account id, a secret,
 * two numbers and an address, re-typed in every new terminal. `.env.local` is
 * already the file this project tells people to keep their settings in, and it
 * is already ignored by git (`*.local`), so the bridge reads its own keys from
 * there too.
 *
 * Only its own keys: TWILIO_*, TELEGRAM_*, JARVIS_* and ELEVENLABS_API_KEY. The file also
 * carries VITE_* settings meant for the browser, and nothing here needs them.
 * A variable already set in the shell wins, so a one-off override still works.
 *
 * Imported first by server.mjs, before anything reads process.env.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const FILE = fileURLToPath(new URL('../.env.local', import.meta.url))
const OURS = /^(TWILIO_|TELEGRAM_|JARVIS_|ELEVENLABS_API_KEY$)/

/** Exported for the tests; returns the keys it would set. */
export function bridgeEnv(text, env = process.env) {
  const parsed = typeof parseEnv === 'function' ? parseEnv(text) : fallbackParse(text)
  const picked = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!OURS.test(key)) continue
    if (env[key] !== undefined && env[key] !== '') continue
    if (typeof value !== 'string' || value.trim() === '') continue
    picked[key] = value.trim()
  }
  return picked
}

/** For Node versions before util.parseEnv (20.12). KEY=value, # comments. */
function fallbackParse(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]
    const quoted = /^(['"])(.*)\1$/.exec(value)
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '')
    out[m[1]] = value
  }
  return out
}

if (process.env.JARVIS_SKIP_ENV_FILE !== '1' && existsSync(FILE)) {
  try {
    const picked = bridgeEnv(readFileSync(FILE, 'utf8'))
    Object.assign(process.env, picked)
    const names = Object.keys(picked)
    if (names.length) console.log(`[jarvis] read ${names.length} setting(s) from .env.local`)
  } catch (err) {
    console.warn(`[jarvis] could not read .env.local: ${err.message}`)
  }
}
