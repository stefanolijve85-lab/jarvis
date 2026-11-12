/**
 * The conversation, kept on the phone itself.
 *
 * Swiping the app away from the recents list kills the page outright — nothing
 * in memory survives it. What should survive is the conversation: the words on
 * screen and which session they belong to. So they are written to
 * localStorage on every turn and whenever the page is put away, and read back
 * when it opens. The session itself lives on in the bridge (see the session id
 * in bridge.ts); this is the page's half of the same promise.
 *
 * Only a deliberate "new conversation" or quit clears it.
 */

import type { Turn } from '../store'

const KEY = 'jarvis-conversation'
/** A conversation older than this is history, not something to resume. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type Saved = { turns: Turn[]; phase: string; at: number }

export function saveConversation(turns: Turn[], phase: string) {
  try {
    const kept = turns.slice(-40).map(({ id, role, text, tools }) => ({ id, role, text, tools }))
    localStorage.setItem(KEY, JSON.stringify({ turns: kept, phase, at: Date.now() }))
  } catch {
    /* storage full or blocked: the bridge still has the session */
  }
}

export function loadConversation(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as Saved
    if (!Array.isArray(saved.turns) || !saved.turns.length) return null
    if (Date.now() - (saved.at || 0) > MAX_AGE_MS) return null
    return saved
  } catch {
    return null
  }
}

export function clearConversation() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}
