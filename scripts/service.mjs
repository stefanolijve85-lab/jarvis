/**
 * Keep JARVIS running on a Linux machine: start at boot, restart if it stops,
 * no terminal left open.
 *
 *   npm run service            install and start (systemd user service)
 *   npm run service -- --remove   stop and remove it
 *
 * It runs `npm run remote` — the interface on your Tailscale address, the
 * phone line, the talk app — as your own user, so it uses your Claude Code
 * login and your .env.local exactly as the terminal did. "Linger" lets a user
 * service start at boot before anyone logs in.
 *
 * Logs: journalctl --user -u jarvis -f
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UNIT_DIR = join(homedir(), '.config', 'systemd', 'user')
const UNIT = join(UNIT_DIR, 'jarvis.service')
const remove = process.argv.includes('--remove')

const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status === 0
const quiet = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0

if (process.platform !== 'linux') {
  console.error('\n  This sets up a Linux (systemd) service. On this computer, use `npm run remote`.\n')
  process.exit(1)
}
if (!quiet('systemctl', ['--user', '--version'])) {
  console.error('\n  systemctl is not available, so a service cannot be installed here.\n')
  process.exit(1)
}

if (remove) {
  quiet('systemctl', ['--user', 'disable', '--now', 'jarvis'])
  rmSync(UNIT, { force: true })
  quiet('systemctl', ['--user', 'daemon-reload'])
  console.log('\n  JARVIS no longer runs in the background. Start him by hand with `npm run remote`.\n')
  process.exit(0)
}

// The PATH this terminal has is the one that finds `claude` (~/.local/bin)
// and `tailscale`; a service otherwise starts with almost nothing on it.
const path = [join(homedir(), '.local', 'bin'), dirname(process.execPath), process.env.PATH]
  .filter(Boolean)
  .join(':')

const unit = `[Unit]
Description=J.A.R.V.I.S. — brain, interface and phone line
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${process.execPath} ${join(ROOT, 'scripts', 'start.mjs')} --remote
Environment=PATH=${path}
Environment=NODE_ENV=development
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`

mkdirSync(UNIT_DIR, { recursive: true })
writeFileSync(UNIT, unit)
console.log(`\n  Wrote ${UNIT}`)

if (!run('systemctl', ['--user', 'daemon-reload'])) process.exit(1)
if (!run('systemctl', ['--user', 'enable', '--now', 'jarvis'])) process.exit(1)

// Start at boot without logging in. Allowed for your own user on most
// systems; where it is not, the one command to run is printed.
const user = userInfo().username
let lingering = false
try {
  lingering = /Linger=yes/.test(
    execFileSync('loginctl', ['show-user', user, '--property=Linger'], { encoding: 'utf8' }),
  )
} catch {
  /* checked below */
}
if (!lingering && !quiet('loginctl', ['enable-linger', user])) {
  console.log(
    '\n  One more step so JARVIS also starts after a reboot, before you log in:\n\n' +
      `      sudo loginctl enable-linger ${user}\n`,
  )
}

console.log(
  '\n  JARVIS now runs in the background and restarts by himself.\n\n' +
    '  See what he is doing:   journalctl --user -u jarvis -f\n' +
    '  Restart after an update: systemctl --user restart jarvis\n' +
    '  Stop for good:          npm run service -- --remove\n',
)
if (existsSync(join(ROOT, '.env.local'))) {
  console.log('  Settings are read from .env.local, as before.\n')
}
