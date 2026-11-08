/**
 * Recovery: carry a chat on when a turn ends badly, without the user typing
 * "continue". Inspired by dsh-continue, redesigned around its known faults:
 *
 *   - It acts only after DSH's own retry (dsh-llm-retry) and in-turn overflow
 *     recovery have given up: it reads the final `turn/end` of an idle chat.
 *   - Permanent failures (quota, credentials, invalid request, unknown model)
 *     stop at once with a visible notice instead of retrying forever.
 *   - The provider's Retry-After is honoured; otherwise exponential backoff
 *     with jitter, a per-incident attempt cap and an hourly cap per chat.
 *   - Context overflow becomes a /new (handoff, with the chunked fallback that
 *     always fits), not a compaction call outside a turn (which DSH refuses).
 *   - A cut-off final answer (max tokens) continues where it stopped.
 *   - A chat whose turn was cut by a crash or restart resumes when it is
 *     loaded again (and recently active chats are loaded at boot), with a
 *     warning about tools whose outcome is unknown.
 *   - Optional fallback model after N failures, for this chat only (the
 *     profile default is never touched), switched back after a good turn.
 *   - Every action lands in History; giving up sends a ghost (and one to the
 *     relay target when the chat reports to a coordinator).
 *
 * If @weibaohui/dsh-continue is still mounted, Recovery stays off so the two
 * never both send "continue".
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const RECOVERY_DEFAULTS = Object.freeze({
  enabled: true,
  maxAttempts: 5,
  baseDelayMs: 2000,
  maxDelayMs: 60000,
  hourlyCap: 20,
  continueTruncated: true,
  overflow: 'handoff', // handoff | stop
  resumeCrashed: true,
  crashWindowMinutes: 20,
  fallbackProvider: '',
  fallbackModel: '',
  fallbackAfter: 3,
  resumeText: '',
})

const PERMANENT = new Set(['QUOTA', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'INVALID_REQUEST', 'MODEL_NOT_FOUND', 'UNSUPPORTED', 'CONTENT_FILTER', 'PERMISSION_DENIED'])
const QUOTA_WORDS = ['quota', 'insufficient', 'balance', 'credit', 'billing', 'exhausted', 'payment']

export function resolveRecovery(value) {
  const v = value && typeof value === 'object' ? value : {}
  const out = { ...RECOVERY_DEFAULTS }
  for (const key of Object.keys(RECOVERY_DEFAULTS)) {
    const d = RECOVERY_DEFAULTS[key]
    if (typeof v[key] === typeof d) out[key] = v[key]
  }
  out.maxAttempts = Math.min(Math.max(Math.round(out.maxAttempts), 0), 20)
  out.baseDelayMs = Math.min(Math.max(Math.round(out.baseDelayMs), 200), 600000)
  out.maxDelayMs = Math.min(Math.max(Math.round(out.maxDelayMs), out.baseDelayMs), 3600000)
  out.hourlyCap = Math.min(Math.max(Math.round(out.hourlyCap), 1), 200)
  out.crashWindowMinutes = Math.min(Math.max(Math.round(out.crashWindowMinutes), 1), 1440)
  out.fallbackAfter = Math.min(Math.max(Math.round(out.fallbackAfter), 1), 20)
  out.overflow = out.overflow === 'stop' ? 'stop' : 'handoff'
  out.resumeText = String(out.resumeText).slice(0, 2000)
  return out
}

/**
 * Classify one failure: { cls, permanent, retryAfterMs, label }.
 * cls: quota | auth | invalid | context | rate-limit | server | transport | unknown
 */
export function classifyFailure(failure) {
  const f = failure && typeof failure === 'object' ? failure : {}
  const code = typeof f.code === 'string' ? f.code : undefined
  const status = Number.isFinite(f.status) ? f.status : undefined
  const msg = typeof f.message === 'string' ? f.message.toLowerCase() : ''
  const retryAfterMs = Number.isFinite(f.providerRetryAfterMs) ? f.providerRetryAfterMs : undefined
  const base = { code, status, retryAfterMs }
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return { ...base, cls: 'context', permanent: false, label: 'the context no longer fits the model' }
  if (code === 'QUOTA' || status === 402 || (status === 429 && QUOTA_WORDS.some((w) => msg.includes(w)))) return { ...base, cls: 'quota', permanent: true, label: 'the provider quota or balance is exhausted' }
  if (code === 'INVALID_CREDENTIAL' || code === 'MISSING_CREDENTIAL' || status === 401 || status === 403) return { ...base, cls: 'auth', permanent: true, label: 'the provider rejected the credentials' }
  if (code && PERMANENT.has(code)) return { ...base, cls: 'invalid', permanent: true, label: `the provider rejected the request (${code})` }
  if (status === 400 || status === 404 || status === 422) return { ...base, cls: 'invalid', permanent: true, label: `the provider rejected the request (HTTP ${status})` }
  if (code === 'RATE_LIMIT' || status === 429) return { ...base, cls: 'rate-limit', permanent: false, label: 'a rate limit' }
  if ((status !== undefined && status >= 500) || code === 'SERVER') return { ...base, cls: 'server', permanent: false, label: `a provider error${status ? ` (HTTP ${status})` : ''}` }
  if (code === 'TIMEOUT' || code === 'TRANSPORT' || code === 'EMPTY_RESPONSE' || code === 'STREAM_IDLE') return { ...base, cls: 'transport', permanent: false, label: 'a connection problem' }
  return { ...base, cls: 'unknown', permanent: false, label: `an error${code ? ` (${code})` : ''}` }
}

export function backoffMs(attempt, cfg, retryAfterMs, random = Math.random) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs + 250, cfg.maxDelayMs)
  const raw = Math.min(cfg.baseDelayMs * 2 ** Math.max(0, attempt - 1), cfg.maxDelayMs)
  return Math.round(raw * (0.8 + random() * 0.4))
}

/** The last finished turn of a chat: { endSeq, reason, startSeq, events (of that turn), endTime } or null. */
export function lastTurn(events) {
  let end = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'turn/end') { end = i; break }
    if (events[i].type === 'turn/start') return null // a turn is open
  }
  if (end < 0) return null
  let start = end
  while (start > 0 && events[start].type !== 'turn/start') start -= 1
  return { endSeq: Number(events[end].seq), reason: events[end].data?.reason ?? {}, startSeq: Number(events[start].seq), events: events.slice(start, end + 1), endTime: events[end].time }
}

/** Tools of a turn whose outcome is unknown after a crash (repair markers or calls without results). */
export function unknownOutcomeTools(turnEvents) {
  const names = new Map()
  const results = new Set()
  for (const e of turnEvents) {
    if (e.type === 'assistant/message') for (const b of e.data?.message?.content ?? []) if (b?.type === 'tool-call') names.set(b.id, b.name)
    if (e.type === 'tool/result') {
      const m = e.data?.message ?? {}
      const code = e.data?.error?.code
      const id = m.toolCallId ?? m.source?.callId
      if (code === 'TOOL_OUTCOME_UNKNOWN' || code === 'TOOL_NOT_STARTED') continue
      results.add(id)
    }
  }
  return [...names.entries()].filter(([id]) => !results.has(id)).map(([, name]) => name)
}

function truncatedFinal(turnEvents) {
  for (let i = turnEvents.length - 1; i >= 0; i -= 1) {
    const e = turnEvents[i]
    if (e.type !== 'assistant/message') continue
    const content = e.data?.message?.content ?? []
    return !content.some((b) => b?.type === 'tool-call')
  }
  return false
}

function profileHasDshContinue() {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const argv = process.argv
    const at = argv.indexOf('--profile')
    const profile = at >= 0 ? argv[at + 1] : process.env.DSH_PROFILE || (argv.includes('web') ? 'web' : 'web')
    const pkg = JSON.parse(readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8'))
    return (pkg.dsh?.profile?.bundles ?? []).includes('@weibaohui/dsh-continue')
  } catch {
    return false
  }
}

export function createRecovery(ctx, conductor, { cfg, log = () => {}, warn = () => {}, agents: agentsFacade, detectContinue = profileHasDshContinue } = {}) {
  const store = conductor.store
  const settings = () => resolveRecovery(cfg()?.recovery)
  const timers = new Map() // sessionId -> timeout
  const handled = new Map() // sessionId -> last handled turn/end seq
  const conflict = detectContinue()
  if (conflict) warn('recovery: @weibaohui/dsh-continue is still mounted, so Recovery stays off (run scripts/migrate-profile.mjs to replace it)')

  function chatState(sessionId) {
    return store.get(sessionId).recovery ?? {}
  }

  function enabledFor(sessionId) {
    const s = settings()
    if (conflict || !s.enabled) return false
    return chatState(sessionId).disabled !== true
  }

  function record(sessionId, text, by = 'recovery') {
    try {
      store.update(sessionId, (s) => {
        s.activity = Array.isArray(s.activity) ? s.activity : []
        s.activity.push({ at: new Date().toISOString(), kind: 'recovery', text: String(text).slice(0, 400), by })
      })
    } catch (error) {
      warn(`recovery: activity not recorded (${error?.message || error})`)
    }
  }

  function setState(sessionId, fn) {
    store.update(sessionId, (s) => {
      s.recovery = { ...(s.recovery ?? {}) }
      fn(s.recovery)
      if (!Object.keys(s.recovery).length) delete s.recovery
    })
  }

  function resumeMessage(text, summary) {
    return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-conductor', form: 'notice', summary: summary.slice(0, 120) } }
  }

  async function giveUp(agent, text) {
    const sessionId = agent.session.id
    record(sessionId, `Stopped: ${text}`)
    setState(sessionId, (r) => { r.attempts = 0; delete r.incidentStart })
    try {
      await conductor.post({ to: sessionId, text: `Recovery stopped: ${text}. Fix the cause, then send a message to continue.`, from: 'Conductor recovery', kind: 'alert', visible: 'user+model' }, { by: 'recovery' })
    } catch (error) {
      warn(`recovery notice: ${error?.message || error}`)
    }
    const relay = store.get(sessionId).relay
    if (relay?.to) {
      await conductor.post({ to: relay.to, text: `Recovery stopped in this chat: ${text}.`, fromSessionId: sessionId, kind: 'alert', visible: 'user+model' }, { by: 'recovery' }).catch(() => {})
    }
  }

  function overHourlyCap(sessionId) {
    const s = settings()
    const recent = (chatState(sessionId).sent ?? []).filter((t) => Date.now() - Date.parse(t) < 3600000)
    return recent.length >= s.hourlyCap
  }

  function schedule(agent, endSeq, delay, text, summary, extra = {}) {
    const sessionId = agent.session.id
    clearTimeout(timers.get(sessionId))
    const timer = setTimeout(async () => {
      timers.delete(sessionId)
      try {
        const live = ctx.agents?.get?.(sessionId) ?? agent
        const events = live.session.snapshotEvents()
        const last = lastTurn(events)
        // a newer turn (the user, or someone else) already took over: do nothing
        if (live.status === 'running' || !last || last.endSeq !== endSeq) return
        if (extra.handoff) {
          const reset = await conductor.reset(live, 'new', { by: 'recovery', focus: 'the request that was running when the context overflowed' })
          if (!reset.ok) return giveUp(live, `the context overflowed and the handoff failed (${reset.text.slice(0, 120)})`)
        }
        if (extra.fallback) setState(sessionId, (r) => { r.fallback = extra.fallback })
        setState(sessionId, (r) => { r.sent = [...(r.sent ?? []).filter((t) => Date.now() - Date.parse(t) < 3600000), new Date().toISOString()] })
        live.followup(resumeMessage(text, summary))
      } catch (error) {
        warn(`recovery: ${error?.message || error}`)
      }
    }, delay)
    timer.unref?.()
    timers.set(sessionId, timer)
  }

  /** Decide what to do with the chat's last finished turn. Exposed for tests. */
  function decide(agent, now = Date.now()) {
    const sessionId = agent.session.id
    const events = agent.session.snapshotEvents()
    const turn = lastTurn(events)
    if (!turn) return { action: 'none' }
    if (handled.get(sessionId) === turn.endSeq || chatState(sessionId).handledSeq === turn.endSeq) return { action: 'none', why: 'already handled' }
    const kind = turn.reason?.kind
    const s = settings()
    const state = chatState(sessionId)
    if (kind === 'completed') return { action: 'success', turn }
    if (kind === 'aborted' || kind === 'blocked') return { action: 'reset', turn }
    if (!enabledFor(sessionId)) return { action: 'none', why: 'disabled', turn }
    const attempts = (state.attempts ?? 0) + 1
    if (attempts > s.maxAttempts) return { action: 'stop', turn, text: `the same problem came back ${s.maxAttempts} times in a row` }
    if (overHourlyCap(sessionId)) return { action: 'stop', turn, text: `more than ${s.hourlyCap} automatic resumes in the last hour (loop guard)` }
    if (kind === 'max-tokens') {
      if (!s.continueTruncated || !truncatedFinal(turn.events)) return { action: 'none', turn }
      return { action: 'resume', turn, attempts, delay: 500, text: 'Your previous answer was cut off at the output limit. Continue exactly where it stopped, without repeating what you already wrote.', summary: 'Recovery: continue the cut-off answer' }
    }
    if (kind === 'interrupted') {
      if (!s.resumeCrashed) return { action: 'none', turn }
      const lastActivity = turn.events.filter((e) => e.type !== 'turn/end' && e.type !== 'step/end').at(-1)?.time ?? turn.endTime
      if (now - lastActivity > s.crashWindowMinutes * 60000) return { action: 'none', why: 'too old', turn }
      const unknown = unknownOutcomeTools(turn.events)
      const warning = unknown.length ? ` These tool calls may or may not have run: ${[...new Set(unknown)].join(', ')}. Check their effects before repeating them.` : ''
      return { action: 'resume', turn, attempts, delay: 1500, text: `Your previous turn was cut off by a restart or crash. ${s.resumeText || 'Continue the task from where it stopped.'}${warning}`, summary: 'Recovery: resume after a restart' }
    }
    if (kind !== 'error') return { action: 'none', turn }
    const failure = classifyFailure(turn.reason.error)
    if (failure.permanent) return { action: 'stop', turn, text: failure.label }
    if (failure.cls === 'context') {
      if (s.overflow === 'stop') return { action: 'stop', turn, text: failure.label }
      return { action: 'resume', turn, attempts, delay: 500, handoff: true, text: 'The context overflowed, so this chat continued from a fresh handoff. Carry on with the request that was running.', summary: 'Recovery: continue after a handoff' }
    }
    const fallback = s.fallbackModel && attempts >= s.fallbackAfter && !state.fallback ? { provider: s.fallbackProvider || undefined, model: s.fallbackModel, since: new Date(now).toISOString() } : null
    const text = `The previous turn failed because of ${failure.label}. ${s.resumeText || 'Continue from where you stopped; do not repeat steps that already succeeded.'}`
    return { action: 'resume', turn, attempts, delay: backoffMs(attempts, s, failure.retryAfterMs), failure, fallback, text, summary: `Recovery: retry after ${failure.label} (attempt ${attempts} of ${s.maxAttempts})` }
  }

  async function onIdle(agent) {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    const d = decide(agent)
    if (d.turn) handled.set(sessionId, d.turn.endSeq)
    switch (d.action) {
      case 'success': {
        const state = chatState(sessionId)
        if (state.attempts || state.fallback) {
          setState(sessionId, (r) => {
            if (r.attempts) { delete r.attempts; delete r.incidentStart }
            if (r.fallback && !r.revert) { r.revert = r.fallback.original ?? true; delete r.fallback }
            r.handledSeq = d.turn.endSeq
          })
          if (state.attempts) record(sessionId, 'Recovered: the turn completed')
        }
        return
      }
      case 'reset':
        if (chatState(sessionId).attempts) setState(sessionId, (r) => { delete r.attempts; delete r.incidentStart; r.handledSeq = d.turn.endSeq })
        return
      case 'stop':
        setState(sessionId, (r) => { r.handledSeq = d.turn.endSeq })
        await giveUp(agent, d.text)
        return
      case 'resume':
        setState(sessionId, (r) => { r.attempts = d.attempts; r.incidentStart ??= new Date().toISOString(); r.handledSeq = d.turn.endSeq })
        record(sessionId, `${d.summary.replace(/^Recovery: /, '')}${d.delay > 1000 ? ` in ${Math.round(d.delay / 1000)} s` : ''}${d.fallback ? `, on the fallback model ${d.fallback.model}` : ''}`)
        schedule(agent, d.turn.endSeq, d.delay, d.text, d.summary, { handoff: d.handoff, fallback: d.fallback })
        return
      default:
    }
  }

  /** The user typed: an automatic resume that is still waiting is no longer wanted. */
  function onRunning(agent) {
    const sessionId = agent?.session?.id
    const timer = sessionId && timers.get(sessionId)
    if (timer) {
      // the timer re-checks the last turn before sending, so only a user turn cancels it
      const events = agent.session.snapshotEvents()
      const lastUser = [...events].reverse().find((e) => e.type === 'user/message')
      if (lastUser?.data?.source?.kind === 'user') { clearTimeout(timer); timers.delete(sessionId) }
    }
  }

  /** agent/request waterfall: the fallback model for this chat only, and switching back. */
  function requestHook(payload, next) {
    const sessionId = payload?.agent?.session?.id
    if (!sessionId) return next()
    const state = store.get(sessionId).recovery
    if (!state?.fallback && !state?.revert) return next()
    return Promise.resolve(next()).then((config) => {
      try {
        if (!config || typeof config !== 'object') return config
        if (state.fallback) {
          if (!state.fallback.original) setState(sessionId, (r) => { if (r.fallback) r.fallback.original = { provider: config.provider, model: config.model } })
          return { ...config, model: state.fallback.model, ...(state.fallback.provider ? { provider: state.fallback.provider } : {}) }
        }
        if (state.revert && typeof state.revert === 'object') {
          const back = state.revert
          setState(sessionId, (r) => { delete r.revert })
          record(sessionId, `Back on ${back.provider}/${back.model} after a good turn on the fallback model`)
          return { ...config, provider: back.provider, model: back.model }
        }
        setState(sessionId, (r) => { delete r.revert })
        return config
      } catch {
        return config
      }
    })
  }

  /** At boot: load chats that were active in the last minutes, so a turn cut by the restart can resume. */
  async function bootScan() {
    const s = settings()
    if (conflict || !s.enabled || !s.resumeCrashed || !agentsFacade) return
    let rows = []
    try { rows = (await agentsFacade.catalog({ force: true }))?.rows ?? [] } catch { return }
    const since = Date.now() - s.crashWindowMinutes * 60000
    const recent = rows.filter((r) => Number(r.updatedAt) >= since && r.origin !== 'subagent').slice(0, 12)
    for (const row of recent) {
      try {
        const agent = await conductor.agentFor(row.sessionId)
        await onIdle(agent)
      } catch (error) {
        warn(`recovery boot scan ${row.sessionId}: ${error?.message || error}`)
      }
    }
    if (recent.length) log(`recovery: checked ${recent.length} recently active chat(s) for turns cut by the restart`)
  }

  function setChat(sessionId, enabled, { by = 'user' } = {}) {
    setState(sessionId, (r) => { if (enabled) delete r.disabled; else r.disabled = true })
    record(sessionId, enabled ? 'Recovery turned on for this chat' : 'Recovery turned off for this chat', by)
    return { ok: true, text: enabled ? 'Recovery is on for this chat.' : 'Recovery is off for this chat: failed turns wait for you.' }
  }

  function status(sessionId) {
    const s = settings()
    const state = chatState(sessionId)
    return {
      enabled: enabledFor(sessionId),
      conflict,
      chatDisabled: state.disabled === true,
      attempts: state.attempts ?? 0,
      maxAttempts: s.maxAttempts,
      waiting: timers.has(sessionId),
      fallback: state.fallback ? state.fallback.model : null,
    }
  }

  function dispose() {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }

  return { decide, onIdle, onRunning, requestHook, bootScan, setChat, status, dispose, conflict }
}
