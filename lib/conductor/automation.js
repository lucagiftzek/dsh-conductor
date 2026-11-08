/**
 * Per-chat automation: scheduled /new (daily at a time, or every N turns).
 * The automatic compaction level and the watermark live in the engine hook
 * (see service.js); this module only decides WHEN a scheduled reset is due.
 *
 * State (side store, per chat): state.autoNew = { daily?: 'HH:MM', tz?, everyTurns?, lastRun?, pending? }
 * A schedule never resumes a cold chat just to reset it: a chat that is not
 * loaded gets its reset at its next idle moment (it costs nothing meanwhile).
 */

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

export function parseAutoNew(words) {
  const [kind, value] = words
  if (!kind) return { error: 'say "daily HH:MM", "turns N" or "off"' }
  if (/^off$/i.test(kind)) return { off: true }
  if (/^daily$/i.test(kind)) {
    if (!TIME.test(value ?? '')) return { error: 'daily needs a time like 03:00' }
    return { daily: value.padStart(5, '0') }
  }
  if (/^(turns|every)$/i.test(kind)) {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 2 || n > 1000) return { error: 'turns needs a whole number between 2 and 1000' }
    return { everyTurns: n }
  }
  return { error: `unknown schedule "${kind}"` }
}

/** The most recent daily due time (as a Date) at or before `now`, in time zone `tz`. */
export function lastDailyDue(hhmm, tz, now = new Date()) {
  const [h, m] = hhmm.split(':').map(Number)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]))
  // minutes since local midnight now vs target; the zone offset is derived from the same instant
  const localMinutes = parts.hour * 60 + parts.minute
  const targetMinutes = h * 60 + m
  const deltaMinutes = localMinutes >= targetMinutes ? localMinutes - targetMinutes : localMinutes - targetMinutes + 24 * 60
  const due = new Date(now.getTime() - deltaMinutes * 60000)
  due.setSeconds(0, 0)
  return due
}

export function describeAutoNew(auto) {
  if (!auto || (!auto.daily && !auto.everyTurns)) return 'no scheduled /new'
  const parts = []
  if (auto.daily) parts.push(`daily at ${auto.daily} (${auto.tz})`)
  if (auto.everyTurns) parts.push(`every ${auto.everyTurns} turns`)
  return `scheduled /new: ${parts.join(' and ')}${auto.lastRun ? `, last run ${auto.lastRun}` : ''}`
}

export function createAutomation(ctx, conductor, { log = () => {}, warn = () => {}, timeZone } = {}) {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const store = conductor.store
  const running = new Set()

  function setAutoNew(sessionId, spec, { by = 'user' } = {}) {
    store.update(sessionId, (s) => {
      if (spec.off) delete s.autoNew
      else s.autoNew = { ...(s.autoNew ?? {}), since: new Date().toISOString(), ...(spec.daily ? { daily: spec.daily, tz } : {}), ...(spec.everyTurns ? { everyTurns: spec.everyTurns } : {}) }
      s.activity.push({ at: new Date().toISOString(), kind: 'setting', text: spec.off ? 'Scheduled /new turned off' : `Scheduled /new: ${describeAutoNew(s.autoNew).replace(/^scheduled \/new: /, '')}`, by })
    })
    return { ok: true, auto: store.get(sessionId).autoNew ?? null, text: describeAutoNew(store.get(sessionId).autoNew) }
  }

  function turnsSince(events, sinceIso) {
    const since = sinceIso ? Date.parse(sinceIso) : 0
    let n = 0
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]
      if (e.time && e.time <= since) break
      if (e.type === 'turn/end') n += 1
    }
    return n
  }

  function lastResetAt(state) {
    const epochs = state.epochs ?? []
    return epochs.length ? epochs[epochs.length - 1].at : undefined
  }

  /** Is a scheduled reset due for this chat now? */
  function due(sessionId, agent, now = new Date()) {
    const state = store.get(sessionId)
    const auto = state.autoNew
    if (!auto) return null
    if (auto.pending) return 'pending'
    if (auto.daily) {
      const target = lastDailyDue(auto.daily, auto.tz || tz, now)
      const created = auto.since ? Date.parse(auto.since) : 0
      if (target.getTime() > created && (!auto.lastRun || Date.parse(auto.lastRun) < target.getTime())) return 'daily'
    }
    if (auto.everyTurns && agent) {
      const since = [auto.lastRun, lastResetAt(state)].filter(Boolean).sort().at(-1)
      if (turnsSince(agent.session.snapshotEvents(), since) >= auto.everyTurns) return 'turns'
    }
    return null
  }

  async function runIfDue(sessionId, agent, reason) {
    if (running.has(sessionId)) return
    const why = reason ?? due(sessionId, agent)
    if (!why) return
    if (!agent || agent.status === 'running' || conductor.isResetting(sessionId)) {
      store.update(sessionId, (s) => { if (s.autoNew) s.autoNew.pending = true })
      return
    }
    running.add(sessionId)
    try {
      store.update(sessionId, (s) => { if (s.autoNew) { s.autoNew.lastRun = new Date().toISOString(); delete s.autoNew.pending } })
      const result = await conductor.reset(agent, 'new', { by: 'schedule' })
      if (!result.ok) conductor.store.activity(sessionId, 'error', `Scheduled /new did not run: ${result.text.slice(0, 160)}`, 'schedule')
    } finally {
      running.delete(sessionId)
    }
  }

  /** Called when a chat goes idle: due turn counts and pending daily runs happen here. */
  async function onIdle(agent) {
    const sessionId = agent?.session?.id
    if (!sessionId || !store.get(sessionId).autoNew) return
    await new Promise((r) => setTimeout(r, 400))
    await runIfDue(sessionId, agent)
  }

  /** Minute tick: daily schedules of loaded, idle chats. */
  async function tick() {
    for (const sessionId of store.known()) {
      const auto = store.get(sessionId).autoNew
      if (!auto?.daily) continue
      const agent = ctx.agents?.get?.(sessionId)
      const why = due(sessionId, agent)
      if (!why) continue
      if (!agent) {
        // not loaded: run at its next idle moment
        store.update(sessionId, (s) => { if (s.autoNew) s.autoNew.pending = true })
        continue
      }
      await runIfDue(sessionId, agent, why).catch((e) => warn(`scheduled /new for ${sessionId}: ${e?.message || e}`))
    }
  }

  function start() {
    const timer = setInterval(() => { void tick().catch((e) => warn(`automation tick: ${e?.message || e}`)) }, 60 * 1000)
    timer.unref?.()
    log(`automation: scheduled /new checks every minute (time zone ${tz})`)
    return () => clearInterval(timer)
  }

  return { setAutoNew, due, runIfDue, onIdle, tick, start, tz }
}
