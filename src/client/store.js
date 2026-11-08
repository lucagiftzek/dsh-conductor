/**
 * Module-level state shared by the Conductor tab, the star button in the
 * message action row, the tab badge and the slash command actions.
 *
 *   sessionModel(id)   the /conductor/session/:id view of one chat
 *   statusModel        the orchestrator /status payload (agents, tasks, runners)
 *   settingsModel      the plugin settings (module switches)
 *   prefs              Better Sidebar pluginSettings of the tab (badge, undo window)
 *   requests           "open the tab on section X" asks from slash commands
 *
 * Every model is a tiny external store (subscribe + getSnapshot) so React
 * reads it with useSyncExternalStore and non-React callers (the badge) read
 * the same numbers.
 */
import { getJson, sessionApi } from './api.js'

export function createSignal(initial) {
  let value = initial
  const listeners = new Set()
  return {
    get: () => value,
    set(next) {
      if (next === value) return
      value = next
      for (const fn of [...listeners]) {
        try { fn() } catch (e) { console.warn('[dsh-conductor] listener failed', e) }
      }
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

// ── per-session view ───────────────────────────────────────────────────

const EMPTY = Object.freeze({ status: 'idle', view: null, error: null, fetchedAt: 0, viewAt: 0 })
const sessions = new Map()

/**
 * One chat's view model. Snapshot shape:
 *   { status: 'idle'|'loading'|'ready'|'error', view, error, fetchedAt }
 * A refresh whose fingerprint is unchanged keeps the same snapshot object
 * (no re-render) except for the progress timer base.
 */
export function sessionModel(sessionId) {
  let model = sessions.get(sessionId)
  if (model) return model
  const signal = createSignal(EMPTY)
  let inflight = null
  model = {
    sessionId,
    subscribe: signal.subscribe,
    getSnapshot: signal.get,
    /** Fetch the view; concurrent callers share one request. */
    refresh() {
      if (inflight) return inflight
      const before = signal.get()
      if (!before.view) signal.set({ ...before, status: 'loading' })
      // While a reset runs, always take the full view: its elapsed time and
      // its result arrive only there.
      const since = before.view && before.status === 'ready' && !before.view.progress ? before.view.fingerprint : undefined
      inflight = sessionApi(sessionId).view(since).then((view) => {
        const cur = signal.get()
        const now = Date.now()
        const same = cur.view && cur.status === 'ready' && (view.unchanged || (cur.view.fingerprint === view.fingerprint && !view.progress && !cur.view.progress))
        if (same) {
          cur.fetchedAt = now // mutate in place: same object, no re-render
          return cur.view
        }
        if (view.unchanged) {
          // the cache was dropped meanwhile: ask again without `since`
          return sessionApi(sessionId).view().then((full) => {
            signal.set({ status: 'ready', view: full, error: null, fetchedAt: Date.now(), viewAt: Date.now() })
            return full
          })
        }
        signal.set({ status: 'ready', view, error: null, fetchedAt: now, viewAt: now })
        return view
      }, (error) => {
        const cur = signal.get()
        signal.set({ ...cur, status: 'error', error, fetchedAt: Date.now() })
        throw error
      }).finally(() => { inflight = null })
      return inflight
    },
    /** Refresh unless a fetch newer than maxAgeMs exists; never throws. */
    ensure(maxAgeMs = 15000) {
      const cur = signal.get()
      if (inflight) return inflight.catch(() => null)
      if (cur.view && Date.now() - cur.fetchedAt < maxAgeMs) return Promise.resolve(cur.view)
      return model.refresh().catch(() => null)
    },
    /** Local optimistic patch of the view (cleared by the next refresh). */
    patch(fn) {
      const cur = signal.get()
      if (!cur.view) return
      signal.set({ ...cur, view: fn(cur.view) })
    },
  }
  sessions.set(sessionId, model)
  return model
}

/** Drop cached models (tests). */
export function resetStores() {
  sessions.clear()
  statusModel.set({ status: 'idle', data: null, error: null })
  settingsModel.set({ status: 'idle', data: null, error: null })
  requests.set({})
  prefs.set({})
  setupRerun.set(false)
}

// ── orchestrator status ────────────────────────────────────────────────

export const statusModel = createSignal({ status: 'idle', data: null, error: null })
let statusInflight = null
export function refreshStatus() {
  if (statusInflight) return statusInflight
  statusInflight = getJson('/status').then((data) => {
    statusModel.set({ status: 'ready', data, error: null })
    return data
  }, (error) => {
    statusModel.set({ ...statusModel.get(), status: 'error', error })
    return null
  }).finally(() => { statusInflight = null })
  return statusInflight
}

export function runningCount() {
  const data = statusModel.get().data
  if (!data) return 0
  const agents = (data.agents && data.agents.running) || 0
  const tasks = (data.tasks && data.tasks.byStatus && data.tasks.byStatus.running) || 0
  return agents + tasks
}

// ── settings ───────────────────────────────────────────────────────────

export const settingsModel = createSignal({ status: 'idle', data: null, error: null })
let settingsInflight = null
export function refreshSettings() {
  if (settingsInflight) return settingsInflight
  settingsInflight = getJson('/settings').then((data) => {
    settingsModel.set({ status: 'ready', data, error: null })
    return data
  }, (error) => {
    settingsModel.set({ ...settingsModel.get(), status: 'error', error })
    return null
  }).finally(() => { settingsInflight = null })
  return settingsInflight
}

/** Module switch from the settings (true while unknown). */
export function moduleOn(name) {
  const data = settingsModel.get().data
  const modules = data && data.settings && data.settings.modules
  return !modules || modules[name] !== false
}

/** True while the user asked to run the setup guide again (no server change until it finishes). */
export const setupRerun = createSignal(false)

/** Whether the first-run guide should show: a fresh install (setupCompleted ''), or a re-run. */
export function setupNeeded() {
  if (setupRerun.get()) return true
  const data = settingsModel.get().data
  return Boolean(data && data.settings && data.settings.setupCompleted === '')
}

// ── tab preferences (Better Sidebar pluginSettings) ────────────────────

export const TAB_ID = 'dsh-conductor:main'
export const prefs = createSignal({})

export const PREF_DEFAULTS = Object.freeze({
  autoPoll: true,
  undoSeconds: 10,
  warnPercent: 80,
  inboxBadge: true,
  autoOpenInbox: false,
})

export function pref(key) {
  const value = prefs.get()[key]
  if (value === undefined || value === null || value === '') return PREF_DEFAULTS[key]
  if (typeof PREF_DEFAULTS[key] === 'number') {
    const n = Number(value)
    return Number.isFinite(n) ? n : PREF_DEFAULTS[key]
  }
  return value
}

// ── section requests (slash commands, the star) ────────────────────────

/** sessionId -> { section, at } */
export const requests = createSignal({})

export function requestSection(sessionId, section) {
  requests.set({ ...requests.get(), [sessionId || '*']: { section, at: Date.now() } })
}

export function takeRequest(sessionId) {
  const all = requests.get()
  const hit = all[sessionId] || all['*']
  if (!hit) return null
  const next = { ...all }
  delete next[sessionId]
  delete next['*']
  requests.set(next)
  return hit
}

// ── badge ──────────────────────────────────────────────────────────────

/** Tab badge: unread inbox count, else running agents and tasks, else null. */
export function badgeFor(sessionId) {
  if (sessionId && pref('inboxBadge') !== false) {
    const model = sessions.get(sessionId)
    const unread = model && model.getSnapshot().view ? Number(model.getSnapshot().view.unread) || 0 : 0
    if (unread > 0) return unread
  }
  const running = runningCount()
  return running > 0 ? running : null
}
