/**
 * Per-chat side store: pins, message versions, inbox, epochs, drops and the
 * activity log of one session, one JSON file per session (0600, atomic
 * rename, debounced). Nothing here is ever sent to a model by itself; the
 * service decides what reaches a session log.
 *
 * Why a side store and not the session log: plugin records in the log are
 * policy-restricted, and a non-ignorable unknown event type would make a
 * session unloadable without this plugin. A side file can be deleted at any
 * time without harming the chat.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const STORE_VERSION = 1
export const CAPS = Object.freeze({ pins: 50, inbox: 300, epochs: 200, drops: 500, activity: 200, versions: 200, versionsPerMessage: 20 })

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

export function emptyState(sessionId) {
  return { version: STORE_VERSION, sessionId, rev: 0, pins: [], versions: [], inbox: [], epochs: [], drops: [], activity: [] }
}

/** Lists every state file has; anything else a feature stores is kept as it is. */
const LISTS = ['pins', 'versions', 'inbox', 'epochs', 'drops', 'activity', 'checkpoints']
/** Per-chat objects the features keep (validated loosely: an object or nothing). */
const OBJECTS = ['autoCompact', 'autoNew', 'relay', 'recovery']

export function normalise(raw, sessionId) {
  const base = emptyState(sessionId)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  // Keep every key a feature wrote, so a restart never drops state a newer
  // version (or another module) stores here; then validate what we know.
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'version' || key === 'sessionId') continue
    base[key] = value
  }
  for (const key of LISTS) {
    base[key] = Array.isArray(raw[key]) ? raw[key].filter((item) => item && typeof item === 'object') : key === 'checkpoints' ? undefined : []
    if (base[key] === undefined) delete base[key]
  }
  for (const key of OBJECTS) {
    if (key in base && (!base[key] || typeof base[key] !== 'object' || Array.isArray(base[key]))) delete base[key]
  }
  if ('handoffTemplate' in base && typeof base.handoffTemplate !== 'string') delete base.handoffTemplate
  base.rev = Number.isInteger(raw.rev) ? raw.rev : 0
  return base
}

export function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 13)}`
}

export class SessionStore {
  /**
   * @param {string} dir directory for the per-session files
   * @param {{ debounceMs?: number, warn?: (m: string) => void }} [options]
   */
  constructor(dir, options = {}) {
    this.dir = dir
    this.debounceMs = options.debounceMs ?? 150
    this.warn = options.warn ?? (() => {})
    this.cache = new Map()
    this.timers = new Map()
    this.listeners = new Set()
    this.ready = false
  }

  file(sessionId) {
    return join(this.dir, `${sessionId}.json`)
  }

  ensureDir() {
    if (this.ready) return
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.ready = true
  }

  /** Read (cached) state of one session. Unknown or unsafe ids get an empty, unsaved state. */
  get(sessionId) {
    if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) return emptyState(String(sessionId))
    const hit = this.cache.get(sessionId)
    if (hit) return hit
    let state
    try {
      state = existsSync(this.file(sessionId)) ? normalise(JSON.parse(readFileSync(this.file(sessionId), 'utf8')), sessionId) : emptyState(sessionId)
    } catch (error) {
      this.warn(`store: unreadable state for ${sessionId} (${error?.message || error}); starting empty`)
      state = emptyState(sessionId)
    }
    this.cache.set(sessionId, state)
    return state
  }

  /**
   * Mutate one session's state through `fn(state)`, cap the lists, bump the
   * revision and schedule a write. Returns whatever `fn` returns.
   */
  update(sessionId, fn) {
    if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) throw new Error('invalid session id')
    const state = this.get(sessionId)
    const out = fn(state)
    for (const [key, cap] of Object.entries(CAPS)) {
      if (Array.isArray(state[key]) && state[key].length > cap) {
        // pins are never silently dropped: callers enforce the pin cap with a clear error
        if (key === 'pins') continue
        state[key] = state[key].slice(-cap)
      }
    }
    state.rev += 1
    this.schedule(sessionId)
    for (const listener of this.listeners) {
      try { listener(sessionId, state) } catch { /* listeners must not break writes */ }
    }
    return out
  }

  /** Append one activity line (also used by the UI log and the toasts mirror). */
  activity(sessionId, kind, text, by = 'user') {
    return this.update(sessionId, (state) => {
      state.activity.push({ at: new Date().toISOString(), kind, text: String(text).slice(0, 500), by })
    })
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  schedule(sessionId) {
    if (this.timers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      this.writeNow(sessionId)
    }, this.debounceMs)
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.set(sessionId, timer)
  }

  writeNow(sessionId) {
    const state = this.cache.get(sessionId)
    if (!state) return
    try {
      this.ensureDir()
      const target = this.file(sessionId)
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`, { mode: 0o600 })
      renameSync(tmp, target)
    } catch (error) {
      this.warn(`store: write failed for ${sessionId}: ${error?.message || error}`)
    }
  }

  /** Flush every pending write (shutdown and tests). */
  flush() {
    for (const [sessionId, timer] of this.timers) {
      clearTimeout(timer)
      this.timers.delete(sessionId)
      this.writeNow(sessionId)
    }
  }

  /** Session ids that have a state file (for the global inbox view). */
  known() {
    try {
      return readdirSync(this.dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
    } catch {
      return []
    }
  }
}
