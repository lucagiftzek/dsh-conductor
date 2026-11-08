/**
 * The Conductor service: one code path for every context and message action,
 * shared by the slash commands, the model tools and the sidebar API.
 *
 *   reset   /new (handoff), /clear, /force-compact  -> compaction modes
 *   drop    /drop, undrop                           -> surface replacements
 *   pins    /pin, /unpin                            -> side store (+ re-added on every reset)
 *   edit    message versions                        -> surface replacement + side store
 *   post    silent message into another chat        -> inbox + model notice + chat row
 *
 * Changes requested by the model while its own turn is running are queued
 * and applied in the next `agent/pre-step` (the seam automatic compaction
 * uses), or after the turn for resets, never inside a tool call.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { installPatch, installLevelPatch, findEngineProto, resolveConfig as resolveEngineConfig, renderArchive, clip } from '../context/engine.js'
import { importCore } from '../context/core-imports.js'
import {
  eventIndex, inventory, planDrop, applyDrop, applyUndrop, applyEdit, compactionOpen, messageOf, noticeMessage, SOURCE_KIND, POST_SOURCE_KIND,
} from '../context/surface.js'
import { SessionStore, CAPS, newId } from './store.js'
import { recall, renderRecall } from './recall.js'

export const RESET_MODES = Object.freeze({ new: 'handoff', clear: 'clear', 'force-compact': 'chunked', pointer: 'pointer' })

/** "1 item", "3 items" */
export function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`
}

export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '?'
  if (n < 1000) return String(Math.round(n))
  if (n < 100000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  if (n < 1000000) return `${Math.round(n / 1000)}K`
  return `${(n / 1000000).toFixed(2).replace(/0$/, '')}M`
}

const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')
const who = (by) => (by === 'model' ? 'the assistant' : by === 'script' ? 'a script' : 'the user')

class ConductorError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function createConductor(ctx, options) {
  const { log = () => {}, warn = () => {} } = options
  const cfgOf = typeof options.cfg === 'function' ? options.cfg : () => options.cfg
  const stateDir = options.stateDir
  const store = options.store ?? new SessionStore(join(stateDir, 'sessions'), { warn })
  const agentsFacade = options.agents ?? null

  const engineState = {
    cfg: resolveEngineConfig({ ...(cfgOf().compact ?? {}), handoffDir: cfgOf().handoffDir || join(stateDir, 'handoffs') }),
    forced: new Map(),
    patched: null,
    log: (level, message) => (level === 'warn' ? warn : log)(`compact: ${message}`),
    onCompaction: (info) => recordAutoEpoch(info),
    pinsFor: (sessionId) => store.get(sessionId).pins,
    levelFor: (agent) => levelFor(agent),
    handoffOptions: (agent) => handoffOptions(agent),
    measure: (agent) => measure(agent.session)?.total,
    onAutoHandoff: (info) => recordAutoHandoff(info),
  }
  const progress = new Map() // sessionId -> { mode, startedAt, step }
  const pending = new Map() // sessionId -> queued ops for the next pre-step
  const afterTurn = new Map() // sessionId -> queued resets for the next idle
  const rowsAfterTurn = new Map() // sessionId -> silent posts whose chat row waits for the turn to end
  const modelInfoCache = new Map()

  const get = (name) => {
    try { return ctx.get(name) ?? null } catch { return null }
  }

  // ── engine patch ─────────────────────────────────────────────────────
  function install() {
    let disposed = false
    let remove
    findEngineProto(ctx).then(({ proto, via, reasons }) => {
      if (disposed) return
      if (proto === null) {
        warn(`compaction engine not found: /new, /clear and /force-compact are inactive (${reasons.join('; ')})`)
        return
      }
      const removeSummary = installPatch(proto, engineState)
      const removeLevel = installLevelPatch(proto, engineState)
      remove = () => { removeLevel(); removeSummary() }
      engineState.patched = via
      log(`compaction hook installed (${via}); archives in ${engineState.cfg.archiveDir}, handoffs in ${engineState.cfg.handoffDir}`)
    }, (error) => warn(`compaction hook failed: ${error?.message || error}`))
    return () => {
      disposed = true
      remove?.()
      engineState.patched = null
    }
  }

  // ── agents and sessions ──────────────────────────────────────────────
  async function agentFor(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new ConductorError('invalid', 'a chat id is required')
    let agent = ctx.agents?.get?.(sessionId)
    if (agent) return agent
    const controller = get('sessionController')
    if (!controller?.resolveAgent) throw new ConductorError('not-found', 'that chat is not loaded and cannot be resumed here')
    try {
      await controller.resolveAgent(sessionId)
    } catch (error) {
      throw new ConductorError('not-found', `chat not found: ${String(error?.message || error).slice(0, 120)}`)
    }
    agent = ctx.agents?.get?.(sessionId)
    if (!agent) throw new ConductorError('not-found', 'chat not found')
    return agent
  }

  function measure(session) {
    const meter = get('tokenMeter')
    try {
      const m = meter?.measure(session)
      if (!m) return null
      const nodes = new Map((m.nodes ?? []).map((n) => [Number(n.seq), n.tokens]))
      return { total: m.totalTokens, nodes }
    } catch {
      return null
    }
  }

  async function modelWindow(session) {
    const route = session.requestHeader?.()?.config
    if (!route?.provider || !route?.model) return null
    const key = `${route.provider}/${route.model}`
    if (modelInfoCache.has(key)) return modelInfoCache.get(key)
    let value = null
    try {
      const info = await get('llm')?.resolveModelInfo(route.provider, route.model, AbortSignal.timeout(5000))
      if (info?.context?.contextWindow) value = { window: info.context.contextWindow, provider: route.provider, model: route.model }
    } catch { /* unknown window */ }
    modelInfoCache.set(key, value)
    return value
  }

  async function balanceHelpers(session) {
    const mod = (await importCore('@deepseek-ai/dsh-compaction')).mod
    if (typeof mod?.toolPairingBalancedBefore !== 'function' || typeof mod?.toolPairingBalancedAfter !== 'function') return null
    return {
      before: (seq) => mod.toolPairingBalancedBefore(session, seq),
      after: (seq) => mod.toolPairingBalancedAfter(session, seq),
    }
  }

  const sessionsService = () => get('sessions')
  async function flushSession(session) {
    try { await sessionsService()?.flush?.(session) } catch { /* the store flushes on its own schedule */ }
  }

  function activity(sessionId, kind, text, by) {
    try { store.activity(sessionId, kind, text, by) } catch { /* never block the action on its log line */ }
  }

  // ── epochs ───────────────────────────────────────────────────────────
  function recordAutoEpoch({ sessionId, kind, archive }) {
    if (!sessionId || engineState.forced.has(sessionId)) return
    const agent = ctx.agents?.get?.(sessionId)
    const before = agent ? measure(agent.session)?.total : undefined
    const id = newId('ep')
    store.update(sessionId, (state) => {
      state.epochs.push({ id, at: new Date().toISOString(), kind, by: 'auto', tokensBefore: before ?? null, tokensAfter: null, archive: archive?.path ?? null, handoff: null })
      delete state.nudgedAt
    })
    // The checkpoint lands after summarize() returns: measure once it has.
    if (agent) {
      const timer = setTimeout(() => {
        const after = measure(agent.session)?.total
        if (after === undefined) return
        store.update(sessionId, (state) => {
          const epoch = state.epochs.find((e) => e.id === id)
          if (epoch) epoch.tokensAfter = after
        })
      }, 1500)
      timer.unref?.()
    }
  }

  /** Subagents and background jobs this chat started that are still running (listed in the handoff). */
  function runningWork(agent) {
    const lines = []
    const sessionId = agent.session.id
    try {
      for (const other of ctx.agents?.list?.() ?? []) {
        const header = other.session?.header ?? {}
        const parent = header.parentSession ?? header.parentSessionId ?? other.parentAgent?.session?.id
        if (other === agent || parent !== sessionId || other.status !== 'running') continue
        lines.push(`- subagent ${other.session.id} (running)`)
      }
    } catch { /* optional seam */ }
    try {
      const jobs = get('jobs')
      const list = typeof jobs?.list === 'function' ? jobs.list() : []
      for (const job of Array.isArray(list) ? list : []) {
        const owner = job.ownerSessionId ?? job.sessionId ?? job.owner
        const status = job.status ?? job.state
        if (owner === sessionId && (status === 'running' || status === 'queued')) lines.push(`- background job ${job.id ?? job.jobId} ${job.kind ? `(${job.kind})` : ''}: ${String(job.title ?? job.command ?? '').slice(0, 100)}`)
      }
    } catch { /* optional seam */ }
    return lines.length ? lines.join('\n') : undefined
  }

  function conductor_recoveryStatus(sessionId) {
    try { return api.recovery?.status(sessionId) ?? null } catch { return null }
  }

  // ── automatic level (when this chat compacts or hands off by itself) ──
  /** { percent, action, source } that applies to this chat, or null when DSH's own default applies. */
  function effectiveLevel(sessionId) {
    const own = store.get(sessionId).autoCompact ?? {}
    if (own.paused) return { paused: true, percent: 0, action: 'compact', source: 'paused' }
    const global = cfgOf().autoCompact ?? {}
    const percent = Number.isFinite(own.percent) ? own.percent : Number(global.percent) || 0
    const action = own.action ?? global.action ?? 'compact'
    return { percent, action, source: Number.isFinite(own.percent) ? 'chat' : percent ? 'global' : 'default', nudge: (own.nudge ?? global.nudge) !== false }
  }

  function levelFor(agent) {
    const sessionId = agent?.session?.id
    if (!sessionId || cfgOf().modules?.context === false) return null
    const level = effectiveLevel(sessionId)
    if (level.paused || !level.percent) return null
    return { ratio: level.percent / 100, action: level.action === 'handoff' ? 'handoff' : 'compact' }
  }

  function handoffOptions(agent) {
    const state = store.get(agent.session.id)
    const template = typeof state.handoffTemplate === 'string' && state.handoffTemplate.trim() ? state.handoffTemplate : (cfgOf().handoffTemplate || '')
    const previousHandoff = [...state.epochs].reverse().find((e) => e.handoff)?.handoff
    return { pins: state.pins, template, previousHandoff, runningWork: runningWork(agent) }
  }

  function recordAutoHandoff({ agent, run, before }) {
    const sessionId = agent.session.id
    const id = newId('ep')
    store.update(sessionId, (s) => {
      s.epochs.push({ id, at: new Date().toISOString(), kind: 'new', by: 'auto', tokensBefore: before ?? null, tokensAfter: null, archive: run.archive?.path ?? null, handoff: run.handoff ?? null, via: run.via })
      s.activity.push({ at: new Date().toISOString(), kind: 'reset', text: `Automatic handoff at the chat's level (${fmtTokens(before)} tokens)`, by: 'auto' })
      delete s.nudgedAt
    })
    const timer = setTimeout(() => {
      const after = measure(agent.session)?.total
      if (after === undefined) return
      store.update(sessionId, (s) => { const e = s.epochs.find((x) => x.id === id); if (e) e.tokensAfter = after })
    }, 1500)
    timer.unref?.()
  }

  function setLevel(sessionId, spec, { by = 'user' } = {}) {
    store.update(sessionId, (s) => {
      const cur = { ...(s.autoCompact ?? {}) }
      if (spec.off) { delete cur.percent; delete cur.action }
      if (Number.isFinite(spec.percent)) cur.percent = Math.round(Math.min(Math.max(spec.percent, 10), 95))
      if (spec.action) cur.action = spec.action
      if (typeof spec.paused === 'boolean') { if (spec.paused) cur.paused = true; else delete cur.paused }
      if (typeof spec.nudge === 'boolean') cur.nudge = spec.nudge
      if (Object.keys(cur).length) s.autoCompact = cur
      else delete s.autoCompact
      s.activity.push({ at: new Date().toISOString(), kind: 'setting', text: describeLevel(effectiveLevelOf(s)), by })
    })
    return { ok: true, level: effectiveLevel(sessionId), text: describeLevel(effectiveLevel(sessionId)) }
  }

  function effectiveLevelOf(state) {
    // same as effectiveLevel, from an in-flight state object
    const own = state.autoCompact ?? {}
    if (own.paused) return { paused: true, percent: 0, action: 'compact', source: 'paused' }
    const global = cfgOf().autoCompact ?? {}
    const percent = Number.isFinite(own.percent) ? own.percent : Number(global.percent) || 0
    return { percent, action: own.action ?? global.action ?? 'compact', source: Number.isFinite(own.percent) ? 'chat' : percent ? 'global' : 'default' }
  }

  function describeLevel(level) {
    if (level.paused) return 'Automatic level paused for this chat: DSH compacts at its own default (80%).'
    if (!level.percent) return 'Automatic level: DSH default (compacts at about 80% of the model window).'
    return `Automatic level: ${level.action === 'handoff' ? 'hands off to a fresh context' : 'compacts'} at ${level.percent}% of the model window (${level.source === 'chat' ? 'this chat' : 'all chats'}).`
  }

  /**
   * Before each model step: a one-time, honest heads-up to the model when the
   * chat nears its automatic level (appended at the end, cache friendly).
   */
  async function preStepNudge(agent) {
    const sessionId = agent?.session?.id
    if (!sessionId || cfgOf().modules?.context === false) return
    const level = effectiveLevel(sessionId)
    if (level.paused || !level.percent || level.nudge === false) return
    const state = store.get(sessionId)
    if (state.nudgedAt) return
    const model = await modelWindow(agent.session)
    const total = measure(agent.session)?.total
    if (!model?.window || !Number.isFinite(total)) return
    const trigger = (model.window * level.percent) / 100
    if (total < trigger * 0.85) return
    const text = `[Conductor: this chat is close to its automatic level (${fmtTokens(total)} of ${fmtTokens(trigger)} tokens). Read less: prefer targeted reads, drop large outputs you no longer need (chat tool, action drop), and finish the current step cleanly. At the level the chat ${level.action === 'handoff' ? 'hands off to a fresh context through a handoff' : 'compacts'} by itself.]`
    agent.session.append('user/message', noticeMessage(text, 'Context close to the automatic level'), { surfaceOp: 'append' })
    store.update(sessionId, (s) => {
      s.nudgedAt = new Date().toISOString()
      s.activity.push({ at: s.nudgedAt, kind: 'reset', text: `Heads-up sent to the model at ${fmtTokens(total)} tokens`, by: 'auto' })
    })
  }

  // ── archive search ────────────────────────────────────────────────────
  function recallFor(sessionId, query, { limit } = {}) {
    const result = recall(sessionId, query, { archiveDir: engineState.cfg.archiveDir, handoffDir: engineState.cfg.handoffDir, limit })
    return { ok: !result.error, ...result, text: renderRecall(result, query) }
  }

  // ── per-chat handoff template ─────────────────────────────────────────
  function setHandoffTemplate(sessionId, template, { by = 'user' } = {}) {
    const clean = typeof template === 'string' ? template.trim().slice(0, 8000) : ''
    store.update(sessionId, (s) => {
      if (clean) s.handoffTemplate = clean
      else delete s.handoffTemplate
      s.activity.push({ at: new Date().toISOString(), kind: 'setting', text: clean ? 'Custom handoff template set for this chat' : 'Handoff template reset to the default', by })
    })
    return { ok: true, text: clean ? 'This chat now uses its own handoff template.' : 'This chat uses the default handoff template again.' }
  }

  // ── relay: final answers of this chat go to a coordinator as ghosts ───
  async function setRelay(sessionId, to, { by = 'user' } = {}) {
    if (!to || to === 'off') {
      store.update(sessionId, (s) => {
        delete s.relay
        s.activity.push({ at: new Date().toISOString(), kind: 'setting', text: 'Relay to another chat turned off', by })
      })
      return { ok: true, text: 'Final answers are no longer relayed.' }
    }
    const resolved = agentsFacade ? await agentsFacade.resolveRef(to) : { kind: 'exact', id: to }
    if (resolved.kind === 'ambiguous') throw new ConductorError('ambiguous', `"${to}" matches several chats: ${resolved.ids.join(', ')}`)
    if (!resolved.id) throw new ConductorError('not-found', resolved.reason ?? 'no chat matches')
    if (resolved.id === sessionId) throw new ConductorError('invalid', 'a chat cannot relay to itself')
    const row = agentsFacade ? (await agentsFacade.catalog().catch(() => null))?.rows?.find((r) => r.sessionId === resolved.id) : null
    const label = row?.title || resolved.id
    store.update(sessionId, (s) => {
      s.relay = { to: resolved.id, label, since: new Date().toISOString(), lastSeq: lastFinalAnswer(eventsOrEmpty(sessionId))?.seq ?? -1 }
      s.activity.push({ at: new Date().toISOString(), kind: 'setting', text: `Final answers are relayed to "${label}" as ghosts`, by })
    })
    return { ok: true, to: resolved.id, text: `From now on, every final answer of this chat arrives in "${label}" as a ghost (silent, it does not wake it).` }
  }

  function eventsOrEmpty(sessionId) {
    try { return ctx.agents?.get?.(sessionId)?.session?.snapshotEvents() ?? [] } catch { return [] }
  }

  /** The final answer of the last finished turn: { seq, text } or null. */
  function lastFinalAnswer(events) {
    let end = -1
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].type === 'turn/end') { end = i; break }
    }
    if (end < 0) return null
    const reason = events[end].data?.reason?.kind
    if (['interrupted', 'error', 'aborted', 'cancelled', 'failed'].includes(reason)) return null
    for (let i = end - 1; i >= 0; i -= 1) {
      const e = events[i]
      if (e.type === 'turn/start') return null
      if (e.type !== 'assistant/message' || (e.surfaceOp && e.surfaceOp !== 'append')) continue
      const message = messageOf(e)
      if ((message?.content ?? []).some((b) => b?.type === 'tool-call')) return null
      const text = textOf(message?.content).trim()
      return text ? { seq: Number(e.seq), text } : null
    }
    return null
  }

  async function relayAfterTurn(agent) {
    const sessionId = agent.session.id
    const relay = store.get(sessionId).relay
    if (!relay?.to) return
    const final = lastFinalAnswer(agent.session.snapshotEvents())
    if (!final || final.seq <= (relay.lastSeq ?? -1)) return
    store.update(sessionId, (s) => { if (s.relay) s.relay.lastSeq = final.seq })
    try {
      await post({ to: relay.to, text: final.text, fromSessionId: sessionId, kind: 'report', visible: 'user+model' }, { by: 'relay' })
    } catch (error) {
      activity(sessionId, 'error', `Relay to "${relay.label}" failed: ${String(error?.message || error).slice(0, 160)}`, 'relay')
    }
  }

  // ── resets: /new, /clear, /force-compact ─────────────────────────────
  /**
   * @param agent live Agent
   * @param kind 'new' | 'clear' | 'force-compact' | 'pointer'
   */
  async function reset(agent, kind, { focus, by = 'user', commandId, signal } = {}) {
    const mode = RESET_MODES[kind]
    if (!mode) throw new ConductorError('invalid', `unknown reset kind ${kind}`)
    if (engineState.patched === null) return { ok: false, text: 'Conductor could not hook the compaction engine, so this command is unavailable (see the server log).' }
    const commands = get('commands')
    const compact = commands?.find?.(agent, 'compact')
    if (!compact) return { ok: false, text: 'This chat\'s agent preset has no compaction engine, so it cannot be reset in place.' }
    const sessionId = agent.session.id
    if (engineState.forced.has(sessionId)) return { ok: false, text: 'A reset is already running in this chat.' }
    if (agent.status === 'running') return { ok: false, busy: true, text: 'The agent is still working. Wait until it finishes (or stop it), then try again.' }
    const state = store.get(sessionId)
    const before = measure(agent.session)?.total
    const previousHandoff = [...state.epochs].reverse().find((e) => e.handoff)?.handoff
    const template = typeof state.handoffTemplate === 'string' && state.handoffTemplate.trim() ? state.handoffTemplate : (cfgOf().handoffTemplate || '')
    const forced = { mode, focus, run: {}, pins: state.pins, previousHandoff, template, runningWork: mode === 'handoff' ? runningWork(agent) : undefined }
    engineState.forced.set(sessionId, forced)
    const abort = new AbortController()
    progress.set(sessionId, { kind, startedAt: Date.now(), by, abort })
    store.update(sessionId, () => {}) // bump rev so the sidebar shows the progress
    let result
    const timeout = AbortSignal.timeout(cfgOf().resetTimeoutMs ?? 15 * 60 * 1000)
    try {
      result = await compact.handler({
        commandId: commandId ?? `conductor-${randomUUID()}`,
        agent,
        rawInput: '',
        attachments: [],
        signal: AbortSignal.any([abort.signal, timeout, ...(signal ? [signal] : [])]),
      })
    } catch (error) {
      result = { kind: 'error', text: String(error?.message || error) }
    } finally {
      engineState.forced.delete(sessionId)
      progress.delete(sessionId)
    }
    const run = forced.run
    const after = measure(agent.session)?.total
    if (result?.kind === 'success' && run.reached) {
      const epoch = {
        id: newId('ep'),
        at: new Date().toISOString(),
        kind,
        by,
        tokensBefore: before ?? null,
        tokensAfter: after ?? null,
        archive: run.archive?.path ?? null,
        handoff: run.handoff ?? null,
        via: run.via ?? (kind === 'force-compact' ? plural(run.parts ?? 0, "part") : undefined),
        focus: focus ?? undefined,
      }
      const numbers = `${fmtTokens(before)} to ${fmtTokens(after)} tokens`
      let text
      if (kind === 'new') text = `Fresh context from a handoff: ${numbers}.${state.pins.length ? ` ${plural(state.pins.length, "pin")} kept.` : ''}${run.handoff ? `\nHandoff: ${run.handoff}` : ''}${run.archive ? `\nArchive: ${run.archive.path}` : ''}`
      else if (kind === 'clear') text = `Context cleared: ${numbers}.${state.pins.length ? ` ${plural(state.pins.length, "pin")} kept.` : ''}${run.archive ? `\nArchive: ${run.archive.path}` : ''}`
      else text = `${result.text ?? 'Compacted.'} ${kind === 'pointer' ? 'Mechanical checkpoint, no model call.' : `Summarized in ${plural(run.parts ?? 1, "part")}, ${plural(run.calls ?? 1, "model call")}.`} (${numbers})${run.archive ? `\nArchive: ${run.archive.path}` : ''}`
      store.update(sessionId, (s) => {
        delete s.nudgedAt
        s.epochs.push(epoch)
        s.activity.push({ at: epoch.at, kind: 'reset', text: `/${kind}: ${numbers}`, by })
      })
      return { ok: true, text, epoch, tokensBefore: before, tokensAfter: after }
    }
    if (result?.kind === 'success') {
      // compaction-basic found nothing safe to replace (a very short chat)
      return { ok: false, nothing: true, text: `${result.text ?? 'Nothing to reset.'} The conversation is too short to reset yet.` }
    }
    if (abort.signal.aborted) {
      activity(sessionId, 'reset', `/${kind} cancelled by ${who(abort.signal.reason?.by ?? 'user')}`, by)
      return { ok: false, cancelled: true, text: `/${kind} cancelled. Your context is unchanged.` }
    }
    const cause = run.error ? ` Cause: ${run.error}` : ''
    const where = run.archive ? ` The verbatim archive was saved anyway: ${run.archive.path}` : ''
    activity(sessionId, 'error', `/${kind} failed: ${(result?.text ?? 'unknown error').slice(0, 200)}`, by)
    return { ok: false, text: `${result?.text ?? 'The reset failed.'}${cause} Your context is unchanged.${where}` }
  }

  /** Abort a running /new, /clear or /force-compact; the context stays as it was. */
  function cancelReset(sessionId, { by = 'user' } = {}) {
    const running = progress.get(sessionId)
    if (!running) return { ok: false, text: 'No reset is running in this chat.' }
    const reason = new Error('cancelled')
    reason.by = by
    running.abort.abort(reason)
    return { ok: true, text: 'Cancelling. Your context stays as it was.' }
  }

    /** A reset requested by the model: runs after its turn ends (compaction needs an idle chat). */
  function scheduleReset(agent, kind, opts) {
    const sessionId = agent.session.id
    if (agent.status !== 'running') return reset(agent, kind, opts)
    afterTurn.set(sessionId, { kind, opts })
    activity(sessionId, 'reset', `/${kind} requested by ${who(opts.by)}: runs when this turn ends`, opts.by)
    return Promise.resolve({ ok: true, deferred: true, text: `/${kind} will run as soon as this turn ends. Finish your answer now; the next turn starts from the fresh context.` })
  }

  // ── inspection ───────────────────────────────────────────────────────
  function activeDrops(state, session) {
    const nodes = new Set(session.surface.nodes.map(Number))
    const map = new Map()
    for (const record of state.drops) if (!record.restoredAt && nodes.has(record.placeholderSeq)) map.set(record.placeholderSeq, record)
    return map
  }

  async function inspect(sessionId) {
    const agent = await agentFor(sessionId)
    const session = agent.session
    const state = store.get(sessionId)
    const events = eventIndex(session)
    const measured = measure(session)
    const pinned = new Set(state.pins.map((p) => p.messageId))
    const items = inventory(session, { events, tokens: measured?.nodes, dropped: activeDrops(state, session), pinned })
    const byCategory = {}
    for (const item of items) byCategory[item.category] = (byCategory[item.category] ?? 0) + item.tokens
    const nodesTotal = items.reduce((sum, item) => sum + item.tokens, 0)
    const total = measured?.total ?? nodesTotal
    byCategory.tools = Math.max(0, total - nodesTotal)
    const model = await modelWindow(session)
    return { agent, session, state, events, items, total, byCategory, window: model?.window ?? null, model }
  }

  // ── drop / undrop ────────────────────────────────────────────────────
  async function saveDropped(sessionId, op, events, session) {
    try {
      const dir = join(engineState.cfg.archiveDir, sessionId.replace(/[^A-Za-z0-9._-]/g, '_'), 'drops')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const messages = op.seqs.map((seq) => {
        try { return session.deriveEventMessage(events.get(seq)) } catch { return messageOf(events.get(seq)) }
      }).filter(Boolean)
      const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${op.start}.md`)
      await writeFile(path, renderArchive(messages, { sessionId, when: new Date().toISOString(), mode: `dropped from context: ${op.label}` }), { mode: 0o600 })
      return path
    } catch (error) {
      warn(`drop: could not save the original (${error?.message || error})`)
      return null
    }
  }

  // DSH's stored-log format accepts a tool/result (and developer/message)
  // only inside an open turn, while user/message replacements are fine at any
  // time. So: message and step drops apply at once; tool outputs dropped while
  // the chat is idle are queued and applied at the very start of the next
  // turn, before its first model request (the seam automatic pruning uses).
  const IN_TURN_ONLY = new Set(['tool', 'developer'])

  async function dropNow(agent, selector, by, { inTurn = false } = {}) {
    const session = agent.session
    const sessionId = session.id
    const view = await inspect(sessionId)
    if (compactionOpen(view.events)) throw new ConductorError('busy', 'a compaction is running in this chat; try again in a moment')
    const balance = await balanceHelpers(session)
    const { ops, skipped } = planDrop(view.items, selector, balance)
    if (ops.length === 0) return { ok: false, dropped: 0, tokens: 0, skipped, text: skipped.length ? `Nothing dropped: ${[...new Set(skipped.map((s) => s.reason))].join('; ')}.` : 'Nothing matched.' }
    const now = inTurn ? ops : ops.filter((op) => !IN_TURN_ONLY.has(op.kind))
    const later = inTurn ? [] : ops.filter((op) => IN_TURN_ONLY.has(op.kind))
    if (later.length) queue(sessionId, { type: 'drop', selector: { seqs: later.flatMap((op) => op.seqs) }, by, labels: later.map((op) => op.label), tokens: later.reduce((s, op) => s + op.tokens, 0) })
    const records = []
    for (const op of now) {
      const file = await saveDropped(sessionId, op, view.events, session)
      const placeholder = applyDrop(session, view.events, op, who(by), file)
      records.push({ id: newId('dr'), at: new Date().toISOString(), by, kind: op.kind, start: op.start, end: op.end, seqs: op.seqs, placeholderSeq: Number(placeholder.seq), label: op.label, tokens: op.tokens, file })
    }
    if (records.length) await flushSession(session)
    const tokens = records.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
    const laterTokens = later.reduce((sum, op) => sum + op.tokens, 0)
    store.update(sessionId, (state) => {
      state.drops.push(...records)
      if (records.length) state.activity.push({ at: new Date().toISOString(), kind: 'drop', text: `Dropped ${plural(records.length, "item")}, about ${fmtTokens(tokens)} tokens`, by })
      if (later.length) state.activity.push({ at: new Date().toISOString(), kind: 'drop', text: `${plural(later.length, "tool output")}, about ${fmtTokens(laterTokens)} tokens, ${later.length === 1 ? 'leaves' : 'leave'} the context when the next turn starts`, by })
    })
    const parts = []
    if (records.length) parts.push(`Dropped ${plural(records.length, "item")}, about ${fmtTokens(tokens)} tokens freed.`)
    if (later.length) parts.push(`${plural(later.length, "tool output")} (about ${fmtTokens(laterTokens)} tokens) ${later.length === 1 ? 'leaves' : 'leave'} the context when the next turn starts.`)
    if (skipped.length) parts.push(`Skipped ${skipped.length}: ${[...new Set(skipped.map((s) => s.reason))].join('; ')}.`)
    return {
      ok: true,
      dropped: records.length,
      queued: later.length,
      tokens: tokens + laterTokens,
      ids: records.map((r) => r.id),
      undoable: records.filter((r) => r.kind !== 'step').map((r) => r.id),
      skipped,
      text: parts.join(' '),
    }
  }

  async function drop(sessionId, selector, { by = 'user' } = {}) {
    const agent = await agentFor(sessionId)
    if (agent.status === 'running') {
      if (by !== 'model') throw new ConductorError('busy', 'the agent is working; drop again when it has finished')
      // Resolve the selector NOW, against what the model saw when it asked
      // ("the last tool output" must not become this very call's own result).
      const view = await inspect(sessionId)
      const { ops, skipped } = planDrop(view.items, selector, await balanceHelpers(agent.session))
      if (ops.length === 0) return { ok: false, dropped: 0, skipped, text: skipped.length ? `Nothing to drop: ${[...new Set(skipped.map((s) => s.reason))].join('; ')}.` : 'Nothing matched.' }
      queue(sessionId, { type: 'drop', selector: { seqs: ops.flatMap((op) => op.seqs) }, by })
      const tokens = ops.reduce((sum, op) => sum + op.tokens, 0)
      return { ok: true, deferred: true, text: `Will drop ${plural(ops.length, 'item')} (about ${fmtTokens(tokens)} tokens) before your next step.` }
    }
    return dropNow(agent, selector, by)
  }

  async function undropNow(agent, records, by, { inTurn = false } = {}) {
    const session = agent.session
    const sessionId = session.id
    const events = eventIndex(session)
    if (compactionOpen(events)) throw new ConductorError('busy', 'a compaction is running in this chat; try again in a moment')
    const now = inTurn ? records : records.filter((r) => !IN_TURN_ONLY.has(r.kind))
    const later = inTurn ? [] : records.filter((r) => IN_TURN_ONLY.has(r.kind))
    if (later.length) queue(sessionId, { type: 'undrop', ids: later.map((r) => r.id), by })
    const done = []
    const failed = []
    for (const record of now) {
      try {
        applyUndrop(session, events, record)
        done.push(record)
      } catch (error) {
        failed.push({ id: record.id, reason: String(error?.message || error) })
      }
    }
    if (done.length) await flushSession(session)
    const tokens = done.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
    const laterTokens = later.reduce((sum, r) => sum + (r.tokens ?? 0), 0)
    store.update(sessionId, (s) => {
      const at = new Date().toISOString()
      for (const record of s.drops) if (done.some((d) => d.id === record.id)) record.restoredAt = at
      if (done.length) s.activity.push({ at, kind: 'drop', text: `Put back ${plural(done.length, "item")}, about ${fmtTokens(tokens)} tokens`, by })
    })
    const parts = []
    if (done.length) parts.push(`Put back ${plural(done.length, "item")}, about ${fmtTokens(tokens)} tokens.`)
    if (later.length) parts.push(`${plural(later.length, "tool output")} (about ${fmtTokens(laterTokens)} tokens) ${later.length === 1 ? 'comes' : 'come'} back when the next turn starts.`)
    if (failed.length) parts.push(`${failed.length} could not be restored: ${failed[0].reason}`)
    return { ok: done.length + later.length > 0, restored: done.length, queued: later.length, tokens: tokens + laterTokens, failed, text: parts.join(' ') || 'Nothing restored.' }
  }

  async function undrop(sessionId, target = 'last', { by = 'user' } = {}) {
    const agent = await agentFor(sessionId)
    if (agent.status === 'running' && by !== 'model') throw new ConductorError('busy', 'the agent is working; try again when it has finished')
    const session = agent.session
    const state = store.get(sessionId)
    const active = activeDrops(state, session)
    if (target === 'pending') {
      const list = pending.get(sessionId) ?? []
      const waiting = list.filter((op) => op.type === 'drop' && op.selector?.seqs)
      if (!waiting.length) return { ok: false, restored: 0, cancelled: 0, text: 'No drop is waiting for the next turn.' }
      pending.set(sessionId, list.filter((op) => !waiting.includes(op)))
      const count = waiting.reduce((n, op) => n + op.selector.seqs.length, 0)
      store.update(sessionId, (s) => { s.activity.push({ at: new Date().toISOString(), kind: 'drop', text: `Cancelled ${plural(count, 'pending drop')}`, by }) })
      return { ok: true, restored: 0, cancelled: count, text: `Cancelled ${plural(count, 'pending drop')}: nothing had left the context yet.` }
    }
    const queuedIds = new Set((pending.get(sessionId) ?? []).filter((op) => op.type === 'undrop').flatMap((op) => op.ids))
    const candidates = [...active.values()].filter((r) => !queuedIds.has(r.id))
    let records
    if (target === 'all') records = candidates
    else if (target === 'last') records = candidates.filter((r) => r.kind !== 'step').slice(-1)
    else records = candidates.filter((r) => r.id === target || (Array.isArray(target) && target.includes(r.id)))
    if (records.length === 0) {
      // a drop still waiting for the next turn can simply be cancelled
      const list = pending.get(sessionId) ?? []
      const waiting = list.filter((op) => op.type === 'drop' && op.selector?.seqs)
      if (waiting.length && (target === 'last' || target === 'all')) {
        pending.set(sessionId, list.filter((op) => !waiting.includes(op)))
        store.update(sessionId, (s) => { s.activity.push({ at: new Date().toISOString(), kind: 'drop', text: 'Cancelled a drop that had not happened yet', by }) })
        return { ok: true, restored: 0, cancelled: waiting.length, text: 'Cancelled the pending drop: nothing had left the context yet.' }
      }
      return { ok: false, restored: 0, text: 'Nothing to put back: that item is no longer dropped (a reset may have replaced it).' }
    }
    if (agent.status === 'running') {
      queue(sessionId, { type: 'undrop', ids: records.map((r) => r.id), by })
      return { ok: true, deferred: true, text: 'Will put it back before your next step.' }
    }
    return undropNow(agent, records, by)
  }

  // ── pins ─────────────────────────────────────────────────────────────
  function findMessage(session, target) {
    const events = session.snapshotEvents()
    const isMessage = (e) => (e.type === 'user/message' || e.type === 'assistant/message') && messageOf(e)
    if (target === undefined || target === null || target === '' || target === 'last') {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i]
        if (e.type === 'assistant/message' && (!e.surfaceOp || e.surfaceOp === 'append') && textOf(messageOf(e)?.content).trim()) return e
      }
      return null
    }
    if (target === 'last-user') {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const e = events[i]
        if (e.type === 'user/message' && messageOf(e)?.source?.kind === 'user' && (!e.surfaceOp || e.surfaceOp === 'append')) return e
      }
      return null
    }
    const asSeq = Number(target)
    if (Number.isInteger(asSeq) && String(asSeq) === String(target).trim()) return events.find((e) => Number(e.seq) === asSeq && isMessage(e)) ?? null
    return events.find((e) => isMessage(e) && messageOf(e).id === target) ?? null
  }

  async function pin(sessionId, target, { note, by = 'user' } = {}) {
    const agent = await agentFor(sessionId)
    const event = findMessage(agent.session, target)
    if (!event) throw new ConductorError('not-found', 'message not found in this chat')
    const message = messageOf(event)
    const text = textOf(message.content).trim()
    if (!text) throw new ConductorError('invalid', 'that message has no text to pin')
    const state = store.get(sessionId)
    const existing = state.pins.find((p) => p.messageId === message.id)
    if (existing) return { ok: true, pin: existing, already: true, text: 'Already pinned.' }
    if (state.pins.length >= CAPS.pins) throw new ConductorError('limit', `Pin limit reached (${CAPS.pins}). Unpin one to add another.`)
    const record = {
      id: newId('pin'),
      messageId: message.id,
      seq: Number(event.seq),
      role: message.role,
      text: clip(text, 6000),
      note: note ? String(note).slice(0, 300) : undefined,
      by,
      at: new Date().toISOString(),
      tokens: Math.ceil(Math.min(text.length, 6000) / 4),
    }
    store.update(sessionId, (s) => {
      s.pins.push(record)
      s.activity.push({ at: record.at, kind: 'pin', text: `Pinned ${record.role} message: ${text.replace(/\s+/g, ' ').slice(0, 60)}`, by })
    })
    return { ok: true, pin: record, text: `Pinned. About ${fmtTokens(record.tokens)} tokens, kept across /new and /clear.` }
  }

  function notePin(sessionId, target, note, { by = 'user' } = {}) {
    const state = store.get(sessionId)
    const pinRecord = state.pins.find((p) => p.id === target || p.messageId === target)
    if (!pinRecord) throw new ConductorError('not-found', 'that message is not pinned')
    if (by === 'model' && pinRecord.by === 'user') throw new ConductorError('forbidden', 'only the user can change a note on a pin the user made')
    const clean = typeof note === 'string' && note.trim() ? note.trim().slice(0, 300) : undefined
    store.update(sessionId, (s) => {
      const p = s.pins.find((x) => x.id === pinRecord.id)
      if (p) { if (clean) p.note = clean; else delete p.note }
    })
    return { ok: true, text: clean ? 'Note saved.' : 'Note removed.' }
  }

  function unpin(sessionId, target, { by = 'user' } = {}) {
    const state = store.get(sessionId)
    const pinRecord = target === 'last' ? state.pins.at(-1) : state.pins.find((p) => p.id === target || p.messageId === target)
    if (!pinRecord) return { ok: false, text: 'That message is not pinned.' }
    if (by === 'model' && pinRecord.by === 'user') throw new ConductorError('forbidden', 'only the user can remove a pin the user made')
    store.update(sessionId, (s) => {
      s.pins = s.pins.filter((p) => p.id !== pinRecord.id)
      s.activity.push({ at: new Date().toISOString(), kind: 'pin', text: `Unpinned: ${pinRecord.text.replace(/\s+/g, ' ').slice(0, 60)}`, by })
    })
    return { ok: true, pin: pinRecord, text: 'Unpinned.' }
  }

  // ── edit with versions ───────────────────────────────────────────────
  async function editNow(agent, target, text, { by, reason }) {
    const session = agent.session
    const sessionId = session.id
    const state = store.get(sessionId)
    const events = eventIndex(session)
    if (compactionOpen(events)) throw new ConductorError('busy', 'a compaction is running in this chat; try again in a moment')
    const original = findMessage(session, target)
    if (!original) throw new ConductorError('not-found', 'message not found in this chat')
    const message = messageOf(original)
    if (by === 'model' && message.role !== 'assistant') throw new ConductorError('forbidden', 'the assistant can only edit its own answers')
    if (message.role === 'assistant' && (message.content ?? []).some((b) => b?.type === 'tool-call')) throw new ConductorError('invalid', 'only final answers (without tool calls) can be edited')
    let entry = state.versions.find((v) => v.messageId === message.id)
    const currentSeq = entry ? entry.replacementSeq : Number(original.seq)
    if (!session.surface.nodes.map(Number).includes(currentSeq)) throw new ConductorError('gone', 'that message is no longer in the model context (a reset or compaction replaced it); edit is only possible while it is in context')
    const balance = await balanceHelpers(session)
    if (!balance || !balance.before(currentSeq) || !balance.after(currentSeq)) throw new ConductorError('busy', 'that message is part of a step that is still open')
    const nextVersion = entry ? entry.versions.length + 1 : 2
    if (nextVersion > CAPS.versionsPerMessage) throw new ConductorError('limit', `version limit reached (${CAPS.versionsPerMessage}) for this message`)
    const author = by === 'model' ? 'the assistant' : 'the user'
    const replacement = applyEdit(session, events, currentSeq, { text, role: message.role, version: nextVersion, author, reason })
    await flushSession(session)
    const now = new Date().toISOString()
    store.update(sessionId, (s) => {
      let e = s.versions.find((v) => v.messageId === message.id)
      if (!e) {
        e = { messageId: message.id, origSeq: Number(original.seq), role: message.role, versions: [{ v: 1, text: textOf(message.content), author: 'original', at: original.time ? new Date(original.time).toISOString() : now }] }
        s.versions.push(e)
      }
      e.versions.push({ v: nextVersion, text, author: by, at: now, reason: reason ? String(reason).slice(0, 300) : undefined })
      e.current = nextVersion
      e.replacementSeq = Number(replacement.seq)
      s.activity.push({ at: now, kind: 'edit', text: `Edited ${message.role} message (version ${nextVersion})${reason ? `: ${reason}` : ''}`, by })
    })
    entry = store.get(sessionId).versions.find((v) => v.messageId === message.id)
    return { ok: true, messageId: message.id, version: nextVersion, text: `Saved version ${nextVersion}. The model sees the new text from its next step; every version is kept.` }
  }

  async function edit(sessionId, target, text, { by = 'user', reason } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new ConductorError('invalid', 'the new text is empty')
    if (text.length > 100000) throw new ConductorError('invalid', 'the new text is too long (100,000 characters max)')
    const agent = await agentFor(sessionId)
    if (agent.status === 'running') {
      if (by !== 'model') throw new ConductorError('busy', 'the agent is working; edit when it has finished')
      queue(sessionId, { type: 'edit', target, text, by, reason })
      return { ok: true, deferred: true, text: 'The edit will apply before your next step.' }
    }
    return editNow(agent, target, text, { by, reason })
  }

  async function restoreVersion(sessionId, messageId, version, { by = 'user' } = {}) {
    const entry = store.get(sessionId).versions.find((v) => v.messageId === messageId)
    const chosen = entry?.versions.find((v) => v.v === Number(version))
    if (!chosen) throw new ConductorError('not-found', 'that version does not exist')
    return edit(sessionId, messageId, chosen.text, { by, reason: `restored version ${chosen.v}` })
  }

  // ── pre-step queue (model actions during its own turn) ───────────────
  function queue(sessionId, op) {
    const list = pending.get(sessionId) ?? []
    list.push(op)
    pending.set(sessionId, list)
  }

  async function runPending(agent) {
    const sessionId = agent?.session?.id
    const list = sessionId && pending.get(sessionId)
    if (!list?.length) return
    pending.delete(sessionId)
    for (const op of list) {
      try {
        if (op.type === 'drop') await dropNow(agent, op.selector, op.by, { inTurn: true })
        else if (op.type === 'undrop') {
          const records = store.get(sessionId).drops.filter((r) => op.ids.includes(r.id) && !r.restoredAt)
          if (records.length) await undropNow(agent, records, op.by, { inTurn: true })
        } else if (op.type === 'edit') await editNow(agent, op.target, op.text, op)
      } catch (error) {
        activity(sessionId, 'error', `${op.type} by ${who(op.by)} failed: ${String(error?.message || error).slice(0, 200)}`, op.by)
      }
    }
  }

  async function onIdle(agent) {
    const sessionId = agent?.session?.id
    if (sessionId) await relayAfterTurn(agent).catch((error) => warn(`relay: ${error?.message || error}`))
    const rows = sessionId && rowsAfterTurn.get(sessionId)
    if (rows?.length) {
      rowsAfterTurn.delete(sessionId)
      await new Promise((resolve) => setImmediate(resolve))
      for (const entry of rows) chatRow(agent.session, entry)
      await flushSession(agent.session)
    }
    const queued = sessionId && afterTurn.get(sessionId)
    if (!queued) return
    afterTurn.delete(sessionId)
    // let the turn settle completely (inbox splice, flush) before compacting
    await new Promise((resolve) => setTimeout(resolve, 250))
    const result = await reset(agent, queued.kind, queued.opts).catch((error) => ({ ok: false, text: String(error?.message || error) }))
    if (!result.ok) activity(sessionId, 'error', `/${queued.kind} requested by ${who(queued.opts.by)} did not run: ${result.text.slice(0, 200)}`, queued.opts.by)
  }

  // ── posts (silent messages) ──────────────────────────────────────────
  function chatRow(session, entry) {
    // Off by default: the web client renders the ghost itself as a message.
    if (cfgOf().posts?.chatRow !== true) return
    try {
      const commandId = `conductor-post-${entry.id}`
      session.append('command/run', { commandId, name: 'post', args: ` from ${entry.from.label}`, source: { kind: 'user' } })
      session.append('command/done', { commandId, kind: 'success', text: entry.text.length > 4000 ? `${entry.text.slice(0, 4000)}\n[...]` : entry.text })
    } catch (error) {
      warn(`post: chat row not shown (${error?.message || error})`)
    }
  }

  function deliverToModel(agent, entry) {
    const header = `[Silent message from ${entry.from.label}${entry.kind && entry.kind !== 'note' ? `, ${entry.kind}` : ''}, ${entry.at}. It did not wake you; take it into account when relevant.]`
    const message = noticeMessage(`${header}\n${entry.text}`, `Message from ${entry.from.label}`, POST_SOURCE_KIND)
    entry.messageId = message.id // lets the chat UI match the rendered ghost to its inbox entry
    if (agent.status === 'running' && typeof agent.inject === 'function') {
      agent.inject(message)
      return 'next-step'
    }
    agent.session.append('user/message', message, { surfaceOp: 'append' })
    return 'appended'
  }

  async function post({ to, text, from, fromSessionId, kind = 'note', visible = 'user+model' } = {}, { by = 'model' } = {}) {
    const body = typeof text === 'string' ? text.trim() : ''
    if (!body) throw new ConductorError('invalid', 'the message is empty')
    if (!to) throw new ConductorError('invalid', 'a target chat is required (id, unique prefix or exact title)')
    if (!['user', 'user+model'].includes(visible)) throw new ConductorError('invalid', 'visible must be "user" or "user+model"')
    const resolved = agentsFacade ? await agentsFacade.resolveRef(to) : { kind: 'exact', id: to }
    if (resolved.kind === 'ambiguous') throw new ConductorError('ambiguous', `"${to}" matches several chats: ${resolved.ids.join(', ')}`)
    if (!resolved.id) throw new ConductorError('not-found', resolved.reason ?? 'no chat matches')
    const targetId = resolved.id
    if (fromSessionId && fromSessionId === targetId) throw new ConductorError('invalid', 'a chat cannot post to itself')
    const max = cfgOf().posts?.maxChars ?? 8000
    let finalText = body
    let file
    if (body.length > max) {
      const dir = join(stateDir, 'posts')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.md`)
      await writeFile(file, body, { mode: 0o600 })
      finalText = `${body.slice(0, Math.min(1500, max))}\n\n[Full text (${body.length} characters) saved at ${file}]`
    }
    let fromLabel = from ? String(from).slice(0, 80) : 'a script'
    if (!from && fromSessionId) {
      const row = agentsFacade ? (await agentsFacade.catalog().catch(() => null))?.rows?.find((r) => r.sessionId === fromSessionId) : null
      fromLabel = row?.title ? `chat "${row.title}"` : `chat ${fromSessionId.slice(0, 16)}`
    }
    const agent = await agentFor(targetId)
    const entry = {
      id: newId('in'),
      at: new Date().toISOString(),
      from: { label: fromLabel, sessionId: fromSessionId ?? null, by },
      kind: ['report', 'alert', 'note'].includes(kind) ? kind : 'note',
      text: finalText,
      file: file ?? null,
      visible,
      read: false,
      delivered: null,
    }
    await new Promise((resolve) => setImmediate(resolve)) // never append inside another session event
    if (visible === 'user+model') {
      try {
        entry.delivered = deliverToModel(agent, entry)
      } catch (error) {
        entry.delivered = `failed: ${String(error?.message || error).slice(0, 120)}`
      }
    }
    if (agent.status === 'running') {
      // command rows belong between turns: show it as soon as this turn ends
      const rows = rowsAfterTurn.get(targetId) ?? []
      rows.push(entry)
      rowsAfterTurn.set(targetId, rows)
    } else {
      chatRow(agent.session, entry)
    }
    await flushSession(agent.session)
    store.update(targetId, (s) => {
      s.inbox.push(entry)
      s.activity.push({ at: entry.at, kind: 'inbox', text: `Ghost from ${fromLabel}: ${finalText.replace(/\s+/g, ' ').slice(0, 60)}`, by })
    })
    return { ok: true, id: entry.id, to: targetId, delivered: entry.delivered, text: `Posted silently to ${targetId}${visible === 'user' ? ' (visible to the user only)' : ''}. The chat was not woken.` }
  }

  function markRead(sessionId, ids = 'all', read = true) {
    let changed = 0
    store.update(sessionId, (s) => {
      for (const entry of s.inbox) {
        if (ids === 'all' || (Array.isArray(ids) && ids.includes(entry.id))) {
          if (entry.read !== read) changed += 1
          entry.read = read
        }
      }
    })
    return { ok: true, changed }
  }

  /** Hide inbox messages (kept for a week so Undo can bring them back). */
  function dismiss(sessionId, ids) {
    let changed = 0
    const now = Date.now()
    store.update(sessionId, (s) => {
      for (const entry of s.inbox) {
        const hit = Array.isArray(ids) ? ids.includes(entry.id) : entry.read
        if (hit && !entry.dismissedAt) { entry.dismissedAt = new Date(now).toISOString(); changed += 1 }
      }
      s.inbox = s.inbox.filter((entry) => !entry.dismissedAt || now - Date.parse(entry.dismissedAt) < 7 * 24 * 3600 * 1000)
    })
    return { ok: true, removed: changed }
  }

  function undismiss(sessionId, ids) {
    let changed = 0
    store.update(sessionId, (s) => {
      for (const entry of s.inbox) {
        if (entry.dismissedAt && (!Array.isArray(ids) || ids.includes(entry.id))) { delete entry.dismissedAt; changed += 1 }
      }
    })
    return { ok: true, restored: changed }
  }

  /** Re-add an inbox message to the model context (the "Add to context" button). */
  async function addToContext(sessionId, id) {
    const entry = store.get(sessionId).inbox.find((e) => e.id === id)
    if (!entry) throw new ConductorError('not-found', 'that message is gone')
    const agent = await agentFor(sessionId)
    await new Promise((resolve) => setImmediate(resolve))
    const delivered = deliverToModel(agent, entry)
    await flushSession(agent.session)
    store.update(sessionId, (s) => {
      const e = s.inbox.find((x) => x.id === id)
      if (e) { e.delivered = delivered; e.read = true }
    })
    return { ok: true, delivered }
  }

  // ── the sidebar view ─────────────────────────────────────────────────
  async function view(sessionId, { since } = {}) {
    const agent = await agentFor(sessionId)
    const session = agent.session
    const state = store.get(sessionId)
    const fingerprint = `${state.rev}:${session.surface.nodes.length}:${session.surface.replaceGeneration ?? 0}:${agent.status}:${progress.has(sessionId) ? 1 : 0}:${pending.get(sessionId)?.length ?? 0}`
    if (since && since === fingerprint) return { ok: true, unchanged: true, fingerprint }
    const v = await inspect(sessionId)
    const queuedSeqs = new Set((pending.get(sessionId) ?? []).filter((op) => op.type === 'drop').flatMap((op) => op.selector?.seqs ?? []))
    const items = v.items.map((item) => ({ ...item, preview: item.preview.slice(0, 240), ...(queuedSeqs.has(item.seq) ? { pendingDrop: true } : {}) }))
    const running = progress.get(sessionId)
    return {
      ok: true,
      fingerprint,
      sessionId,
      status: agent.status,
      model: v.model,
      meter: { total: v.total, window: v.window, categories: v.byCategory },
      items,
      pins: state.pins,
      inbox: state.inbox.filter((e) => !e.dismissedAt).reverse(),
      unread: state.inbox.filter((e) => !e.read && !e.dismissedAt).length,
      epochs: [...state.epochs].reverse(),
      versions: state.versions,
      drops: [...state.drops].reverse().slice(0, 100),
      activity: [...state.activity].reverse().slice(0, 100),
      relay: state.relay ?? null,
      autoNew: state.autoNew ?? null,
      level: effectiveLevel(sessionId),
      recovery: conductor_recoveryStatus(sessionId),
      checkpoints: [...(state.checkpoints ?? [])].reverse().slice(0, 40),
      handoffTemplate: state.handoffTemplate ?? null,
      progress: running ? { kind: running.kind, by: running.by, startedAt: running.startedAt, elapsedMs: Date.now() - running.startedAt } : null,
      pending: { steps: pending.get(sessionId)?.length ?? 0, afterTurn: afterTurn.get(sessionId)?.kind ?? null },
      engine: engineState.patched ? 'ready' : 'unavailable',
    }
  }

  /** One full context item (the "Show all" preview). */
  async function item(sessionId, seq) {
    const agent = await agentFor(sessionId)
    const event = eventIndex(agent.session).get(Number(seq))
    if (!event) throw new ConductorError('not-found', 'no such item')
    const message = messageOf(event) ?? {}
    return { ok: true, seq: Number(seq), type: event.type, role: message.role, text: clip(textOf(message.content), 200000), blocks: (message.content ?? []).map((b) => b?.type) }
  }

  const api = {
    store,
    engineState,
    install,
    agentFor,
    measure,
    reset,
    scheduleReset,
    inspect,
    view,
    item,
    drop,
    undrop,
    pin,
    unpin,
    edit,
    restoreVersion,
    post,
    markRead,
    dismiss,
    undismiss,
    notePin,
    cancelReset,
    recallFor,
    setLevel,
    effectiveLevel,
    preStepNudge,
    setRelay,
    setHandoffTemplate,
    lastFinalAnswer,
    addToContext,
    runPending,
    onIdle,
    hasPending: (sessionId) => (pending.get(sessionId)?.length ?? 0) > 0,
    isResetting: (sessionId) => progress.has(sessionId),
    ConductorError,
    SOURCE_KIND,
  }
  return api
}

export { ConductorError }
