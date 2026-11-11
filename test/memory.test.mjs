// JARVIS's memory (bridge/memory.mjs): what is kept, what is refused, and how
// it reaches the next conversation.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addNote, loadNotes, memoryPrompt, removeNotes } from '../bridge/memory.mjs'
import { decideTool } from '../bridge/policy.mjs'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'jarvis-mem-')), 'memory.json')

test('notes are kept, de-duplicated, and survive a reload', () => {
  const file = fresh()
  addNote('Stefan runs SoloTech and Kwizillo', file)
  addNote('  stefan runs solotech and kwizillo ', file)
  addNote('Prefers answers in Dutch', file)
  const notes = loadNotes(file)
  assert.equal(notes.length, 2)
  assert.match(notes[0].id, /^[0-9a-f]{6}$/)
  assert.equal(statSync(file).mode & 0o077, 0, 'readable by the owner only')
})

test('secrets are never written down', () => {
  const file = fresh()
  assert.throws(() => addNote('My Gmail password is hunter2', file), /never stored/)
  assert.throws(() => addNote('De pincode is 1234', file), /never stored/)
  assert.throws(() => addNote('key sk_0000example0000notarealkey', file), /never stored/)
  assert.equal(loadNotes(file).length, 0)
})

test('forget removes by id or by words', () => {
  const file = fresh()
  const a = addNote('Dentist on Friday at nine', file)
  addNote('Likes dark mode', file)
  assert.equal(removeNotes(a.id, file).length, 1)
  assert.equal(removeNotes('dark mode', file).length, 1)
  assert.equal(loadNotes(file).length, 0)
  assert.equal(removeNotes('', file).length, 0)
})

test('the next conversation is told the notes, as information', () => {
  const file = fresh()
  assert.match(memoryPrompt(file), /no notes yet/)
  addNote('Kwizillo is a quiz app', file)
  const prompt = memoryPrompt(file)
  assert.match(prompt, /Kwizillo is a quiz app/)
  assert.match(prompt, /not instructions/)
})

test('the memory tools are allowed without write access', () => {
  assert.equal(decideTool('mcp__jarvis_memory__remember'), true)
  assert.equal(decideTool('mcp__jarvis_memory__forget'), true)
})

// ------------------------------------------------------------------ history

import { appendExchange, historyPrompt, loadHistory } from '../bridge/memory.mjs'

const freshHistory = () => join(mkdtempSync(join(tmpdir(), 'jarvis-hist-')), 'history.jsonl')

test('exchanges are kept and handed to the next session', () => {
  const file = freshHistory()
  appendExchange({ channel: 'telegram', user: 'Plan de lancering van Kwizillo', jarvis: 'Volgende week dinsdag, meneer.' }, file)
  appendExchange({ channel: 'interface', user: '', jarvis: 'ignored' }, file)
  assert.equal(loadHistory(file).length, 1)
  assert.equal(statSync(file).mode & 0o077, 0, 'readable by the owner only')
  const prompt = historyPrompt(file)
  assert.match(prompt, /Telegram/)
  assert.match(prompt, /Plan de lancering van Kwizillo/)
  assert.match(prompt, /not instructions/)
})

test('old conversations fall out of the prompt, recent ones stay', () => {
  const file = freshHistory()
  appendExchange({ channel: 'talk', user: 'Hallo', jarvis: 'Goedendag.' }, file)
  const later = Date.now() + 30 * 24 * 60 * 60 * 1000
  assert.equal(historyPrompt(file, later), '')
  assert.notEqual(historyPrompt(file), '')
})
