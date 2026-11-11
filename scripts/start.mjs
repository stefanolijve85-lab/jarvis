/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`.
 *
 * Pass --remote (`npm run remote`) to reach JARVIS from anywhere: from your
 * phone or another computer, over Tailscale. See remoteSetup() below.
 */

import { execFileSync, spawn } from 'node:child_process'
import process from 'node:process'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

const writes = process.argv.includes('--writes')
const remote = process.argv.includes('--remote')

/**
 * Tailscale's command-line tool. On a Mac the app ships it inside the bundle
 * rather than on PATH, so look there too.
 */
function tailscaleCli() {
  const candidates = [
    'tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
  ]
  for (const cli of candidates) {
    try {
      execFileSync(cli, ['version'], { stdio: 'ignore' })
      return cli
    } catch {
      /* try the next */
    }
  }
  return null
}

/**
 * Runs a Tailscale command. Time-limited, because when something has to be
 * switched on for the tailnet first (HTTPS certificates, Funnel) Tailscale
 * prints a link and waits for it to be visited; the error then carries that
 * link, and it is printed for you to open.
 */
function tailscale(cli, args) {
  return execFileSync(cli, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  })
}

const said = (err) =>
  [err.stdout, err.stderr, err.code === 'ETIMEDOUT' ? '' : err.message]
    .filter(Boolean)
    .map((t) => String(t).trim())
    .filter(Boolean)
    .join('\n  ')

/**
 * Reaching JARVIS from anywhere, privately.
 *
 * Tailscale joins this computer and your phone into one private network.
 * `tailscale serve` then gives the interface an https:// address that only
 * your own devices can open — https matters, because browsers only allow the
 * microphone on secure pages. Nothing is opened to the internet.
 *
 * The one exception, and only if a Twilio phone line is set up: Twilio has to
 * reach the phone line's webhooks, so `tailscale funnel` publishes THAT port
 * (8443 → the phone line on 8788) to the internet. The phone line answers only
 * signed requests from Twilio about your own number; the interface, your files
 * and your browser stay private.
 */
function remoteSetup(bridgeEnv) {
  const cli = tailscaleCli()
  if (!cli) {
    console.error(
      '\n  Tailscale is not installed. Install it from https://tailscale.com/download\n' +
        '  on this computer AND on your phone, sign in with the same account on both,\n' +
        '  then run `npm run remote` again.\n',
    )
    process.exit(1)
  }
  let status
  try {
    status = JSON.parse(tailscale(cli, ['status', '--json']))
  } catch {
    status = null
  }
  const dns = status?.Self?.DNSName?.replace(/\.$/, '')
  if (!dns || status?.BackendState !== 'Running') {
    console.error(
      '\n  Tailscale is installed but not connected. Open the Tailscale app, sign in,\n' +
        '  and make sure it says Connected. Then run `npm run remote` again.\n',
    )
    process.exit(1)
  }

  const facePort = Number(process.env.PORT) || 5173
  const origin = `https://${dns}`
  try {
    tailscale(cli, ['serve', '--bg', '--https=443', `http://127.0.0.1:${facePort}`])
  } catch (err) {
    console.error(
      `\n  Tailscale would not serve the interface:\n  ${said(err)}\n` +
        '  If it mentions HTTPS certificates, turn on HTTPS for your tailnet at\n' +
        '  https://login.tailscale.com/admin/dns and run `npm run remote` again.\n',
    )
    process.exit(1)
  }

  const existing = process.env.JARVIS_ALLOWED_ORIGINS
  bridgeEnv.JARVIS_ALLOWED_ORIGINS = [existing, origin].filter(Boolean).join(',')
  bridgeEnv.JARVIS_PUBLIC_ORIGIN = origin

  // The phone line, if one is configured (in the shell or in .env.local).
  const phonePort = Number(process.env.JARVIS_PHONE_PORT) || 8788
  if (phoneConfigured()) {
    try {
      tailscale(cli, ['funnel', '--bg', '--https=8443', `http://127.0.0.1:${phonePort}`])
      if (!process.env.JARVIS_PHONE_PUBLIC_URL) {
        bridgeEnv.JARVIS_PHONE_PUBLIC_URL = `https://${dns}:8443`
      }
      console.log(`  phone line reachable by Twilio at https://${dns}:8443`)
    } catch (err) {
      console.warn(
        `  Tailscale Funnel is not available, so Twilio cannot reach the phone line:\n` +
          `  ${said(err)}\n` +
          '  Funnel has to be allowed once for your tailnet — open the link above if there\n' +
          '  is one, or see https://tailscale.com/kb/1223/funnel. WhatsApp messages from\n' +
          '  JARVIS still go out; calls and replies need Funnel.\n',
      )
    }
  }

  // A sleeping Mac answers nothing. caffeinate keeps it awake for exactly as
  // long as JARVIS runs (with the lid open, or closed on power with a screen).
  if (process.platform === 'darwin') {
    try {
      const awake = spawn('caffeinate', ['-is'], { stdio: 'ignore' })
      awake.on('error', () => {})
      children.push(awake)
    } catch {
      /* not fatal */
    }
  }

  console.log(
    `\n  Open JARVIS from any of your devices on Tailscale:\n\n      ${origin}\n` +
      `\n  On a phone, open the talk app instead — light, and made for talking:\n\n      ${origin}/talk\n`,
  )
}

/** Whether .env.local or the shell carries a Twilio account. */
function phoneConfigured() {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) return true
  try {
    const text = existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : ''
    return /^\s*TWILIO_ACCOUNT_SID\s*=\s*\S/m.test(text) && /^\s*TWILIO_AUTH_TOKEN\s*=\s*\S/m.test(text)
  } catch {
    return false
  }
}

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

const children = []

function run(name, command, args, colour, env) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('exit', (code) => {
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); stopping the rest.`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every MCP server on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing, because the handshake is being 403'd
 * somewhere neither half reports. Passing the port through closes that gap
 * without widening what the bridge trusts by default.
 */
const port = process.env.PORT
const bridgeEnv = writes ? { JARVIS_ALLOW_WRITES: '1' } : {}
if (port) {
  bridgeEnv.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
}

vendorWasm()
if (remote) remoteSetup(bridgeEnv)

console.log('\nJ.A.R.V.I.S. starting — the brain and the face.\n')
run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv)
// npm is a shell script on most systems; call the vite binary directly so we do
// not need shell:true (which would break the argument handling above).
run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', {})

console.log(
  '\nWhen it says the dev server is ready, open the URL it prints in Chrome,\n' +
    'click INITIALISE, and say "Hey Jarvis". Ctrl-C stops everything.\n',
)
