# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey Jarvis”**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly, or only the
ones you name in `JARVIS_MCP_SERVERS`. Depending on what you have installed, that
is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Servers you added through your **claude.ai
> account** (mail, drive, calendar and other account connectors) are not in `~/.claude.json`,
> but the CLI fetches them on its own and they join the session from the second
> turn. The bridge keeps them out by default; set `JARVIS_ACCOUNT_CONNECTORS=1`
> to let them in, and `JARVIS_MCP_SERVERS` to choose which `~/.claude.json`
> servers JARVIS gets.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Reach JARVIS from anywhere — and let him call you

Three optional extras, each independent of the others:

- **Open JARVIS from your phone or another computer**, privately, over
  [Tailscale](https://tailscale.com).
- **Phone calls.** JARVIS rings your mobile and holds a real spoken conversation
  ("call me in twenty minutes about the render"), and picks up when you ring him.
- **WhatsApp.** He messages you ("send that link to my phone"), and you can
  message him back from anywhere.

Your computer is still the brain, so it has to be on and awake. `npm run
remote` keeps a Mac awake for as long as JARVIS runs.

### 1. Tailscale — reach the interface from your phone

1. Install Tailscale on this computer **and** on your phone
   (<https://tailscale.com/download>), and sign in with the same account on both.
2. In the Tailscale admin console, under **DNS**, turn on **MagicDNS** and
   **HTTPS Certificates** (<https://login.tailscale.com/admin/dns>).
3. Start JARVIS with:

   ```bash
   npm run remote
   ```

   It prints an address like `https://your-mac.tailnet-name.ts.net`. Open it in
   Chrome on any of your Tailscale devices.

Only devices signed in to your tailnet can open that address; nothing is opened
to the internet. It is https, which is what lets the browser use the microphone
there. Behind it, the page talks to the bridge through the dev server's
`/bridge` proxy, and the bridge accepts exactly that one extra origin.

### The talk app — JARVIS on your phone, for free

The full interface is a 3D scene made for a desktop browser; on a phone it
stutters, and an iPhone has no reliable speech recognition for it to use. The
talk app is the light alternative: a single button, made for talking.

Open **`https://your-machine.your-tailnet.ts.net/talk`** on your phone, with
Tailscale on. Tap the reactor once and talk: JARVIS listens until you stop,
answers out loud, and listens again, for as long as the conversation lasts.
Pauses do not end it. **Hang up** does, or five minutes of silence. Tap the
reactor while he speaks to interrupt. With **Wake word** on, he answers only
what mentions "Jarvis", plus follow-ups within half a minute of his last
answer, so a television in the room is left alone. You can type as well. In
Safari, *Share → Add to Home Screen* makes it an app of its own. The reactor is
drawn in 2D, so it stays light.

With an ElevenLabs key (`ELEVENLABS_API_KEY` in `.env.local`), both the talk
app and the full interface speak with the ElevenLabs voice instead (George, a
British male, by default). Its model is multilingual, so it speaks Dutch
too.

- **Hearing happens on your own computer.** The phone records the raw audio
  and sends it to the bridge's `/listen`, where Whisper (through
  transformers.js) turns it into text. Nothing goes to a speech service and
  nothing costs per minute. The model downloads once, on first start, into
  `~/.jarvis/models`. That is a few hundred MB for `whisper-small`.
- **Speaking also happens on your own computer.** [Piper](https://github.com/rhasspy/piper)
  makes his voice, and the phone plays it as audio through `/speak`. A phone's
  own speech synthesis cannot be relied on: in Chrome on an iPhone it is often
  silent. Piper and a Dutch voice (`nl-rdh-medium`) download once into
  `~/.jarvis/piper`, about 80 MB. If they cannot load, the phone's own voice
  takes over.
- It is the same agent, with no screen tools: the socket connects with
  `?mode=talk`.

`JARVIS_WHISPER_MODEL` picks another model. `onnx-community/whisper-base` is
faster; `onnx-community/whisper-large-v3-turbo` understands far better but
needs a strong CPU. `JARVIS_TALK_LANGUAGE` sets the language (default `nl-NL`),
and `JARVIS_WHISPER=off` turns hearing off.

### The conversation survives the app being closed

Putting the app away, locking the phone, or swiping it out of the recents list
is a pause, not a reset. The page writes the conversation and its session id
to the phone's own storage on every turn and when it is put away. The bridge
keeps the session for 12 hours after its client goes (`JARVIS_PARK_MINUTES`),
numbering every frame. When the app opens again it shows the conversation,
offers **VERDER GAAN** instead of the start-up sequence, and continues the same
session, including any answer that finished while it was closed. The voice is
stopped whenever the app is put away, so two voices never overlap. Only saying
*"nieuw gesprek"* / *"new conversation"* (start over) or *"sluit af"* /
*"quit"* ends it.

### Keep JARVIS running (Linux)

```bash
npm run service
```

This installs JARVIS as a systemd user service. He then starts at boot,
restarts if he stops, and needs no terminal left open. He runs `npm run remote`
as your own user, with your Claude Code login and your `.env.local`. Use
`journalctl --user -u jarvis -f` to see what he is doing,
`systemctl --user restart jarvis` after an update, and
`npm run service -- --remove` to stop for good.

### Memory

JARVIS keeps short notes about you between conversations: who you are, your
businesses, people, preferences and plans. Every conversation starts with them,
whether it happens in the interface, the talk app, a call or on Telegram. Say
*"remember that…"* or *"forget that…"*, or just tell him things he will plainly
need again. The notes are a plain file you can read and edit,
`~/.jarvis/memory.json`. Passwords, codes and keys are refused. The notes are
handed to the model as information, never as instructions. `JARVIS_MEMORY=off`
turns memory off.

He also remembers the conversation itself. Every exchange, on any surface, is
kept in `~/.jarvis/history.jsonl`. The most recent ones, from the past two
weeks, are handed to each new session, and the interface shows the last few
again when it opens. Anything older he finds with `recall` when you refer to
it: *"what did we agree last month about…"*. So closing the app on your phone
and opening it again, or carrying on in Telegram what you started in the
interface, picks up where you were. Only your words and his answers are kept,
not the pages or mails he read. `JARVIS_HISTORY=off` turns it off.

### Mail, calendar, content: your claude.ai connectors

Connectors you add to your claude.ai account (Gmail, Google Calendar, Google
Drive, Canva, and others) can join JARVIS's sessions too:

1. Connect them at claude.ai → Settings → Connectors.
2. In `.env.local`: `JARVIS_ACCOUNT_CONNECTORS=1`, and `JARVIS_ALLOW_WRITES=1`
   for anything that sends, posts or changes things.
3. Restart JARVIS. They join from the second message of a conversation.

With writes on, JARVIS says exactly what he is about to send, post, pay, delete
or change in your calendar, and waits for your *yes* first. He never acts on
instructions found inside a mail or page.

### Telegram — message him, send voice notes, and get called (free)

A Telegram bot with his own name and picture. It is free and permanent, and
nothing has to be reachable from the internet: the bridge fetches messages from
Telegram itself.

1. In Telegram, open **@BotFather** and send `/newbot`. Choose a name
   (`Jarvis`) and a username ending in `bot`. BotFather replies with a
   **token**. `/setuserpic` gives him a picture.
2. Put the token in `.env.local` as `TELEGRAM_BOT_TOKEN=...`.
3. For voice messages, install ffmpeg: `sudo apt install ffmpeg`.
4. Restart JARVIS. The terminal (or `journalctl --user -u jarvis -f`) shows
   `send: /start 123456`. Send exactly that to your bot. From then on it
   answers only you. The link is kept in `~/.jarvis/telegram.json`.

Write to him, or send a voice message: speech is recognised on your computer
with Whisper, and he answers with a voice message in his own voice (ElevenLabs
with a key, otherwise Piper) as well as the text. *"Call me in ten minutes"*
sends a notification with a button that opens the talk app. *"Send me that"*
messages you. Anyone else who finds the bot gets no answer.

### 2. Twilio — calls and WhatsApp

1. Make an account at <https://www.twilio.com>. A trial account works for
   testing; it can only call and message numbers you have verified, which is
   yours.
2. **For calls**, buy a phone number with voice in the Twilio console. Then
   open **Voice → Settings → General** and enable the **Predictive and
   Generative AI/ML Features Addendum**. Calls run on Twilio's
   ConversationRelay, which needs it.
3. **For WhatsApp**, open **Messaging → Try it out → Send a WhatsApp message**
   and send the `join …` code it shows from your own WhatsApp to the sandbox
   number. Then, under **Sandbox settings**, set **When a message comes in** to
   the address the bridge prints at startup (it ends in `/twilio/whatsapp`),
   method POST.
4. Put your settings in `.env.local` (git ignores it):

   ```bash
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your-auth-token
   JARVIS_OWNER_PHONE=+31612345678
   TWILIO_PHONE_NUMBER=+15551234567
   ```

5. Start with `npm run remote`. The first time, Tailscale may ask you to allow
   **Funnel** for your tailnet and print a link to do so. Open it and run the
   command again.

On startup the bridge points your Twilio number's incoming calls at itself, so
ringing that number reaches JARVIS. Then just ask: *"call me in ten minutes"*,
*"send me that on WhatsApp"*. Or ring him, or message him.

**Good to know**

- WhatsApp only lets a business number message you within **24 hours of your
  last message to it**. The sandbox also expires after a few days of silence;
  send `join …` again to renew it. For a permanent number, register a WhatsApp
  sender in Twilio and set `TWILIO_WHATSAPP_FROM`.
- Twilio charges per minute and per message. A trial account comes with credit.
- A call starts a fresh conversation, with no memory of what was said in the
  browser. JARVIS hands it a briefing when he places the call.
- A call or message scheduled for later is held in memory. Restarting the
  bridge forgets it.

### How it is kept safe

- **One number.** The tools take no destination. JARVIS can only ever call or
  message `JARVIS_OWNER_PHONE`, and calls or messages from any other number are
  rejected or ignored.
- **A separate door.** Twilio has to reach this computer from the internet, so
  the phone line is its own small server (port 8788) that serves nothing but
  three Twilio routes. Tailscale Funnel publishes only that port, as `:8443`.
  The interface, the bridge, your files and your browser stay private.
- **Signed requests.** Every webhook must carry a valid `X-Twilio-Signature`,
  an HMAC keyed with your auth token. A call's audio stream is accepted only
  with a one-time token that was handed to Twilio inside a signed exchange.
- **A ceiling.** At most 6 calls and 40 messages go out per hour, whatever the
  agent is talked into.
- Everything else about the agent is unchanged: the same model, the same
  read-only gate and the same tools as in the browser, minus the screen.

---

## Configuration

Everything is optional in bridge mode. Frontend settings live in `.env.local`
(copy `.env.example`); bridge settings are environment variables.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_BRIDGE_HOST` | `127.0.0.1` | Interface to listen on. Any other address puts the agent on your network |
| `JARVIS_ALLOWED_HOSTS` | none | Extra hostnames the bridge answers to; a request for any other name gets a 403 |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `medium` | Reasoning effort |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_MCP_SERVERS` | all configured | Comma-separated `~/.claude.json` servers to pass on; empty passes none |
| `JARVIS_ACCOUNT_CONNECTORS` | off | `1` lets your claude.ai account's connectors join the session |
| `JARVIS_DISABLE` | none | Comma-separated capabilities to leave out: `browser`, `camera`, `interface` |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_WORKSPACE` | `~/.jarvis/workspace` | The agent's working directory; file tools are confined to it and the temp directory |
| `JARVIS_FILE_ROOTS` | none | Extra folders the file tools and the `/file` endpoint may use |
| `JARVIS_KEEP_TRANSCRIPTS` | off | `1` keeps the SDK's session transcripts in `~/.claude/projects` |
| `JARVIS_CLAUDE_EXECUTABLE` | bundled CLI | Run the agent through this executable instead, e.g. a sandbox wrapper that execs the real CLI |
| `JARVIS_CHROME_PIPE` | none | WSL only: the Windows pipe name the browser relay connects to |
| `JARVIS_DEBUG` | off | `1` logs every agent message to the bridge terminal, answer text and tool calls included |
| `JARVIS_VOICE_ID` | none | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | none | Optional; enables the ElevenLabs voice + Scribe |
| `JARVIS_STT` | `elevenlabs` with a key | `browser` keeps the browser's own speech recognition while speaking with ElevenLabs |
| `JARVIS_PUBLIC_ORIGIN` | none | Set by `npm run remote`: the Tailscale address the interface is opened from |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | none | Your Twilio account; turns the phone line on |
| `JARVIS_OWNER_PHONE` | none | Your mobile, e.g. `+31612345678`: the only number JARVIS calls, messages or answers |
| `TWILIO_PHONE_NUMBER` | none | The Twilio voice number calls come from and go to |
| `TWILIO_WHATSAPP_FROM` | `+14155238886` | The WhatsApp sender (the sandbox by default) |
| `JARVIS_PHONE_PUBLIC_URL` | from Funnel | Where Twilio reaches the phone line; `npm run remote` fills it in |
| `JARVIS_PHONE_PORT` | `8788` | Local port of the phone line |
| `TELEGRAM_BOT_TOKEN` | none | The bot's token from @BotFather; turns Telegram on |
| `TELEGRAM_OWNER_ID` | from pairing | Your Telegram user id, instead of pairing with `/start <code>` |
| `JARVIS_MEMORY` | on | `off` turns the memory off |
| `JARVIS_MEMORY_FILE` | `~/.jarvis/memory.json` | Where the notes are kept |
| `JARVIS_TALK_LANGUAGE` | `nl-NL` | Language the talk app listens and speaks in |
| `JARVIS_WHISPER_MODEL` | `onnx-community/whisper-small` | Speech recognition model for the talk app |
| `JARVIS_WHISPER` | on | `off` turns speech recognition off |
| `JARVIS_WHISPER_PRELOAD` | on | `0` loads the model on first use instead of at startup |
| `JARVIS_PIPER_VOICE` | `nl-rdh-medium` | The talk app's voice, made on this machine by Piper (also `nl-nathalie-x-low`, `nl-mls_5809-low`) |
| `JARVIS_PIPER_VOICE_EN` | `en-gb-alan-low` | The full interface's fallback voice, in English, when the browser's own voice fails and there is no ElevenLabs key |
| `JARVIS_PIPER_MODEL` | none | A Piper `.onnx` voice you downloaded yourself, used instead |
| `JARVIS_PIPER` | on | `off` leaves the talk app on the phone's own voice |
| `JARVIS_PIPER_PRELOAD` | on | `0` prepares the voice on first use instead of at startup |
| `JARVIS_PHONE_LANGUAGE` | `nl-NL` | Language callers are heard and answered in |
| `JARVIS_PHONE_GREETING` | `Ja, meneer?` | What he says when he picks up |
| `JARVIS_PHONE_TTS_PROVIDER`, `JARVIS_PHONE_VOICE` | Twilio's default | Text-to-speech on calls |

The bridge also reads these from `.env.local`, its own keys only (`JARVIS_*`,
`TWILIO_*`, `ELEVENLABS_API_KEY`). A value set in the shell wins.

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge. Default: `ws://localhost:8787` on this machine, the page's own `/bridge` proxy from anywhere else |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time, in
`decideTool()` in `bridge/policy.mjs`. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

A `PreToolUse` hook applies that policy to every call, including the reads the
Claude Code CLI would otherwise approve by itself. In read-only mode the agent
has no shell, and its file tools reach only its workspace (`~/.jarvis/workspace`),
the temp directory and any folders in `JARVIS_FILE_ROOTS`. Paths that hold
credentials, such as `~/.ssh`, `~/.claude` and `.env` files, stay refused even
inside those folders.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

The script passes `--writes` to the bridge, so it works in Windows `cmd` and
PowerShell too. With `npm start`, use `npm start -- --writes`. Writes add `Bash`,
`Write`, `Edit` and `NotebookEdit` to the agent's tools. The file tools stay
inside the same folders; the shell can reach anything your user account can.

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`. If the port is taken,
the bridge says so in one line at startup and exits. It listens on `127.0.0.1`
only. Reaching it from another machine takes `JARVIS_BRIDGE_HOST` and
`JARVIS_ALLOWED_HOSTS`, and your own authentication in front of it first.

**Browser control on Windows.** The bridge finds the Claude extension's named
pipe, `\\.\pipe\claude-mcp-browser-bridge-<user>`, by itself. If the boot log
says the extension is not running, open Chrome with the extension signed in.
Each browser request looks for the pipe again, so the bridge does not need a
restart.

**Running the bridge in WSL, with Chrome on Windows.** Browser control works:
the Windows native host exposes a named pipe rather than a Unix socket, and the
bridge reaches it through a short PowerShell relay (WSL interop must be on,
which it is by default). Open the app at `http://127.0.0.1:5173` if
`localhost` is slow to load — Windows tries IPv6 loopback first, and WSL does
not forward it.

---

## Tests

`npm test` runs the bridge's tests with Node's built-in runner. They cover the
network binding, the tool policy, the MCP server allowlist and the WSL browser
relay, which runs only under WSL. The network and allowlist tests start the
bridge on a random loopback port, and none of the tests opens an agent session.

---

## Security

The bridge's defences live in `bridge/server.mjs` and `bridge/policy.mjs`:

- It listens on `127.0.0.1` and answers only requests addressed to `localhost`,
  `127.0.0.1` or `[::1]`, which blocks DNS rebinding.
- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A `PreToolUse` hook enforces the tool policy on every call. File tools stay
  inside the workspace, the temp directory and `JARVIS_FILE_ROOTS`, and
  `WebFetch` cannot reach loopback, LAN or cloud metadata addresses.
- claude.ai account connectors stay out of the session unless
  `JARVIS_ACCOUNT_CONNECTORS=1`, and `JARVIS_MCP_SERVERS` narrows which
  `~/.claude.json` servers the agent gets.
- Session transcripts are written to `~/.claude/projects` only when
  `JARVIS_KEEP_TRANSCRIPTS=1`.
- `JARVIS_DISABLE` removes browser control, the camera or the interface tools
  entirely, and `JARVIS_CLAUDE_EXECUTABLE` can run the agent inside a sandbox
  wrapper.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
