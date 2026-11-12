// The morning briefing JARVIS writes himself (bridge/briefing.mjs).
//
//   node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { amsterdamNow, briefingConfig, checkSites, createBriefing, isDue } from '../bridge/briefing.mjs'
import { decideTool } from '../bridge/policy.mjs'

test('the time is read as Amsterdam time, summer and winter', () => {
  assert.deepEqual(amsterdamNow(new Date('2026-07-01T06:00:00Z')), { date: '2026-07-01', minutes: 8 * 60 })
  assert.deepEqual(amsterdamNow(new Date('2026-01-15T07:30:00Z')), { date: '2026-01-15', minutes: 8 * 60 + 30 })
  assert.equal(amsterdamNow(new Date('2026-01-15T23:30:00Z')).date, '2026-01-16')
})

test('it is due from the set time, once a day, and not in the evening', () => {
  const cfg = briefingConfig({ JARVIS_BRIEFING_TIME: '08:00' })
  const at = (iso) => new Date(iso)
  assert.equal(isDue(cfg, null, at('2026-01-15T06:59:00Z')), false) // 07:59
  assert.equal(isDue(cfg, null, at('2026-01-15T07:00:00Z')), true) // 08:00
  assert.equal(isDue(cfg, '2026-01-15', at('2026-01-15T07:05:00Z')), false) // already sent
  assert.equal(isDue(cfg, '2026-01-14', at('2026-01-15T09:30:00Z')), true) // late, still morning
  assert.equal(isDue(cfg, '2026-01-14', at('2026-01-15T18:00:00Z')), false) // evening
})

test('the configuration keeps only real URLs and a valid time', () => {
  const cfg = briefingConfig({
    JARVIS_BRIEFING_TIME: '7:15',
    JARVIS_BRIEFING_SITES: 'https://a.example, nonsense , http://b.example/x',
  })
  assert.equal(cfg.hour, 7)
  assert.equal(cfg.minute, 15)
  assert.deepEqual(cfg.sites, ['https://a.example', 'http://b.example/x'])
  assert.equal(briefingConfig({ JARVIS_BRIEFING_TIME: '25:00' }).hour, 8)
  assert.equal(briefingConfig({ JARVIS_BRIEFING: 'off' }).off, true)
})

test('site checks report online, a bad status, and offline', async () => {
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/broken' ? 500 : 200)
    res.end('ok')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const [up, broken, gone] = await checkSites([`${base}/`, `${base}/broken`, 'http://127.0.0.1:9/'])
  server.close()
  assert.match(up, /online \(\d+ ms\)/)
  assert.match(broken, /PROBLEEM — status 500/)
  assert.match(gone, /OFFLINE/)
})

test('the briefing is written by the agent, sent with a talk button, and noted', async () => {
  const state = join(mkdtempSync(join(tmpdir(), 'jarvis-brief-')), 'briefing.json')
  const cfg = { ...briefingConfig({}), state, sites: [], lat: 0, lon: 0 }
  const asked = []
  const converse = ({ onDone }) => {
    const c = {
      say: (t) => {
        asked.push(t)
        setTimeout(() => onDone(asked.length === 1 ? 'Goedemorgen.' : '📅 Vandaag\nNiets gepland.'), 5)
      },
      close() {},
    }
    return c
  }
  const sent = []
  const briefing = createBriefing(
    cfg,
    converse,
    {
      telegram: { talkUrl: 'https://jarvis.example/talk', send: async (text, extra) => sent.push({ text, extra }) },
      whatsapp: async () => {
        throw new Error('not set up')
      },
    },
    { connectorsWarmup: true },
  )
  const text = await briefing.send({ reason: 'test' })
  assert.equal(asked.length, 2) // a warm-up first, then the request
  assert.match(asked[1], /Kwizillo, Detepo, SoloTech/)
  assert.equal(text, '📅 Vandaag\nNiets gepland.')
  assert.match(sent[0].text, /^☀️ Ochtendbriefing — \d{4}-\d\d-\d\d\n\n📅 Vandaag/)
  assert.equal(sent[0].extra.reply_markup.inline_keyboard[0][0].url, 'https://jarvis.example/talk')
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).date, amsterdamNow().date)
})

test('the briefing tool is allowed through the policy', () => {
  assert.equal(decideTool('mcp__jarvis_briefing__send_briefing_now'), true)
})
