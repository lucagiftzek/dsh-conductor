/**
 * dsh-conductor: the agent surface.
 *
 * Everything here goes through the harness's OWN public seams, never its
 * internals:
 *
 *   ctx.agents            the live agent registry (.list(), .get(id));
 *                          agent.followup(message) is the supported
 *                          "send into a live session" primitive.
 *   ctx.get('sessionController')  create / prompt / cancel / fork / rename /
 *                          list / page: the same Remote the browser uses.
 *   ctx.get('sessionQuery')       cheap catalog + title snapshots.
 *
 * A plugin cannot import @deepseek-ai/* statically (a drift release is a
 * boot-killing SyntaxError on this profile), so every optional service is
 * reached defensively and a missing seam degrades to an honest error row
 * instead of a crash.
 */

'use strict'

import { randomUUID } from 'node:crypto'
import { LIMITS, str, isSafeId } from './core.js'

const PREFIX_MIN_LEN = 6

function pluginMessage(text, pluginId) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: `plugin:${pluginId}` },
  }
}

/** Build the agents facade over a cordis ctx. cfg may be a resolved config
 * OR a getter () => resolvedConfig: a getter keeps every read live against
 * settings changes (the index.js wiring passes a getter). */
export function makeAgents(ctx, cfgOrGetter, { log = () => {}, warn = () => {} } = {}) {
  const cfgOf = typeof cfgOrGetter === 'function' ? cfgOrGetter : () => cfgOrGetter
  const controllers = () => {
    const c = ctx.get && ctx.get('sessionController')
    return c && typeof c.create === 'function' ? c : null
  }
  const query = () => {
    const q = ctx.get && ctx.get('sessionQuery')
    return q && typeof q.listSessions === 'function' ? q : null
  }

  // ── catalog ───────────────────────────────────────────────────────────────

  let cache = { at: 0, rows: [], known: new Set(), titles: new Map(), degraded: null }

  /** Race a promise against a budget; resolve {ok, value} never rejects. */
  async function withBudget(promise, ms, label) {
    let timer = null
    try {
      const value = await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(Symbol.for('timeout')), Math.max(200, ms))
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
      if (value === Symbol.for('timeout')) return { ok: false, reason: label + ' exceeded its ' + ms + 'ms budget' }
      return { ok: true, value }
    } catch (e) {
      return { ok: false, reason: label + ': ' + String(e && e.message || e) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function catalog({ force = false } = {}) {
    const now = Date.now()
    if (!force && now - cache.at < cfgOf().agents.catalogTtlMs) return cache
    const rows = []
    const known = new Set()
    const titles = new Map()
    const degraded = []
    const push = (h, extra = {}) => {
      if (!h || typeof h.id !== 'string' || !isSafeId(h.id)) return
      if (known.has(h.id)) return
      known.add(h.id)
      rows.push({
        sessionId: h.id,
        title: typeof h.title === 'string' ? str(h.title, LIMITS.titleChars) : '',
        origin: h.origin === 'subagent' ? 'subagent' : 'chat',
        parentSessionId: typeof h.parentSessionId === 'string' ? h.parentSessionId : undefined,
        cwd: typeof h.cwd === 'string' ? str(h.cwd, LIMITS.labelChars) : '',
        createdAt: Number.isFinite(h.createdAt) ? h.createdAt : 0,
        updatedAt: Number.isFinite(h.updatedAt) ? h.updatedAt : (Number.isFinite(h.createdAt) ? h.createdAt : 0),
        ...extra,
      })
    }
    try {
      const ctl = controllers()
      if (ctl) {
        const budget = Number(cfgOf().agents.listBudgetMs) > 0 ? Number(cfgOf().agents.listBudgetMs) : 12000 // internal knob (tests)
        const listed = await withBudget(ctl.list({}, AbortSignal.timeout(budget + 3000)), budget, 'sessionController.list')
        if (!listed.ok) {
          degraded.push(listed.reason)
          // fall through to the cheaper sessionQuery seam before giving up
          const q = query()
          if (q) {
            const alt = await withBudget(q.listSessions(), 8000, 'sessionQuery.listSessions')
            if (!alt.ok) {
              degraded.push(alt.reason)
            } else {
              for (const rec of (alt.value || []).slice(0, cfgOf().agents.catalogMax * 2)) {
                const h = rec && rec.header
                const live = ctx.agents ? ctx.agents.get(h.id) : undefined
                push(h, { live: Boolean(live), running: Boolean(live && live.status === 'running') })
              }
            }
          }
        } else {
        const v = listed.value
        for (const s of (v && v.items) || []) {
          const live = ctx.agents ? ctx.agents.get(s.sessionId) : undefined
          // SessionSummary rows carry sessionId; normalize to the header shape
          // the push() helper expects (id, origin, parentSessionId, cwd).
          push({
            id: s.sessionId,
            title: titles.get(s.sessionId) || s.title,
            origin: s.origin,
            parentSessionId: s.parentSessionId,
            cwd: s.cwd,
            createdAt: undefined,
            updatedAt: s.updatedAt,
          }, {
            live: Boolean(live),
            running: Boolean(live && live.status === 'running'),
            blank: Boolean(s.blank),
          })
        }
        }
      } else {
        const q = query()
        if (q) {
          const listed = await withBudget(q.listSessions(), 8000, 'sessionQuery.listSessions')
          if (!listed.ok) {
            degraded.push(listed.reason)
          } else {
          for (const rec of (listed.value || []).slice(0, cfgOf().agents.catalogMax * 2)) {
            const h = rec && rec.header
            const live = ctx.agents ? ctx.agents.get(h.id) : undefined
            push(h, { live: Boolean(live), running: Boolean(live && live.status === 'running') })
          }
          }
        }
      }
    } catch (e) { warn('catalog: ' + (e && e.message || e)) }
    // Live agents absent from the record set are still resolvable.
    if (ctx.agents && typeof ctx.agents.list === 'function') {
      for (const a of ctx.agents.list()) {
        const id = a && a.id
        if (typeof id !== 'string' || !isSafeId(id) || known.has(id)) continue
        const header = a.session && a.session.header
        if (header && header.origin === 'subagent') {
          known.add(id)
          rows.push({
            sessionId: id,
            title: '',
            origin: 'subagent',
            parentSessionId: (header.parentSessionId ? String(header.parentSessionId) : undefined),
            cwd: typeof header.cwd === 'string' ? str(header.cwd, LIMITS.labelChars) : '',
            createdAt: 0, updatedAt: 0,
            live: true,
            running: a.status === 'running',
          })
          continue
        }
        push(header || { id }, { live: true, running: a.status === 'running' })
      }
    }
    // Titles: PREVIOUS titles survive rebuilds (they change rarely); a fresh
    // snapshot runs in the BACKGROUND and lands in the cache - the tab's next
    // 4s poll picks it up. Titles never block the response and never count as
    // 'degraded': missing titles are cosmetic, not a data gap.
    const prevTitles = cache.titles instanceof Map ? cache.titles : new Map()
    for (const r of rows) {
      const t = prevTitles.get(r.sessionId)
      if (t) r.title = t
      if (!r.title && r.origin === 'subagent') r.title = '(subagent)'
    }
    rows.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    cache = { at: now, rows: rows.slice(0, cfgOf().agents.catalogMax), known, titles: prevTitles, degraded: degraded.length ? degraded : null }
    scheduleTitleRefresh()
    return cache
  }

  /** Background title snapshot pass; guarded against overlapping runs. */
  let titlesInFlight = false
  function scheduleTitleRefresh() {
    if (titlesInFlight) return
    const q = query()
    if (!q || typeof q.readTitleSnapshots !== 'function') return
    const ids = cache.rows.map((r) => r.sessionId).slice(0, 400)
    if (!ids.length) return
    titlesInFlight = true
    void (async () => {
      try {
        const snapped = await withBudget(q.readTitleSnapshots(ids), 30000, 'readTitleSnapshots')
        if (!snapped.ok) {
          log('title refresh skipped: ' + snapped.reason)
          return
        }
        const merged = new Map(cache.titles)
        for (const s of snapped.value || []) {
          const t = s && s.value && s.value.title && s.value.title.title
          if (s && s.status === 'fulfilled' && s.sessionId && typeof t === 'string' && t) {
            merged.set(s.sessionId, str(t, LIMITS.titleChars))
          }
        }
        // merge into the CURRENT cache (rows may have been rebuilt meanwhile)
        cache = {
          ...cache,
          titles: merged,
          rows: cache.rows.map((r) => {
            const t = merged.get(r.sessionId)
            return t ? { ...r, title: t } : r
          }),
        }
      } finally {
        titlesInFlight = false
      }
    })()
  }

  /** Resolve a user/api reference: exact id, id prefix, or exact title. */
  async function resolveRef(ref) {
    const raw = str(ref, LIMITS.idChars).trim()
    if (!raw) return { kind: 'invalid', reason: 'empty reference' }
    const cat = await catalog()
    // exact live agent id first (cheapest, authoritative)
    if (ctx.agents && typeof ctx.agents.get === 'function' && ctx.agents.get(raw)) {
      return { kind: 'exact', id: raw }
    }
    const known = [...cat.known]
    if (known.includes(raw)) return { kind: 'exact', id: raw }
    if (raw.length >= PREFIX_MIN_LEN) {
      const matches = known.filter((id) => id.startsWith(raw))
      if (matches.length === 1) return { kind: 'prefix', id: matches[0] }
      if (matches.length > 1) return { kind: 'ambiguous', ids: matches.slice(0, 8) }
    }
    const lower = raw.toLowerCase()
    const byTitle = cat.rows.filter((r) => r.title && r.title.toLowerCase() === lower)
    if (byTitle.length === 1) return { kind: 'title', id: byTitle[0].sessionId }
    if (byTitle.length > 1) return { kind: 'ambiguous', ids: byTitle.slice(0, 8).map((r) => r.sessionId) }
    // An id-shaped reference the catalog has not seen yet is still worth one
    // shot through the controller (it may have been created milliseconds ago).
    if (isSafeId(raw) && raw.length >= 8) return { kind: 'exact', id: raw, unverified: true }
    return { kind: 'unknown', reason: 'no agent matches ' + raw.slice(0, 40) }
  }

  // ── commands ──────────────────────────────────────────────────────────────

  async function spawn({ title, prompt, preset, cwd, count = 1 }) {
    const ctl = controllers()
    if (!ctl) return { ok: false, error: 'sessionController is unavailable in this composition' }
    const n = Math.min(Math.max(1, Number(count) || 1), cfgOf().agents.spawnMax)
    const created = []
    const failures = []
    for (let i = 0; i < n; i++) {
      try {
        const req = {}
        if (typeof preset === 'string' && preset.trim()) req.agentPreset = preset.trim()
        else if (cfgOf().agents.defaultPreset) req.agentPreset = cfgOf().agents.defaultPreset
        if (typeof cwd === 'string' && cwd.trim()) req.cwd = cwd.trim()
        else if (cfgOf().agents.defaultCwd) req.cwd = cfgOf().agents.defaultCwd
        const v = await ctl.create(req)
        if (!v || !v.sessionId) throw new Error('create returned no session id')
        const sid = v.sessionId
        const t = n > 1 && title ? String(title).replaceAll('{i}', String(i + 1)) : title
        if (t && typeof ctl.rename === 'function') {
          try { await ctl.rename({ sessionId: sid, title: str(t, LIMITS.titleChars) }) } catch { /* title is cosmetic */ }
        }
        created.push({ sessionId: sid, preset: v.agentPreset })
      } catch (e) {
        failures.push(String(e && e.message || e))
      }
    }
    let prompted = 0
    if (prompt && created.length) {
      for (const c of created) {
        const text = n > 1 ? String(prompt).replaceAll('{i}', String(created.indexOf(c) + 1)) : prompt
        // NOTE: the spawn parameter `prompt` (the first message) shadows the
        // internal prompt() helper inside this function, so reference it via
        // the facade-local alias (bug caught live: 'prompt is not a function').
        const r = await promptSession({ sessionId: c.sessionId, text })
        if (r.ok) prompted += 1
        else failures.push('prompt ' + c.sessionId + ': ' + r.error)
      }
    }
    return { ok: created.length > 0, created, prompted, failures }
  }

  /**
   * Fork (split) a chat, optionally titling it and delivering a first message.
   * One implementation shared by the HTTP route, the orch_agent_fork tool and
   * the machine API so their behaviour cannot drift.
   */
  async function fork(sessionId, { atSeq, title, prompt: firstMessage } = {}) {
    const ctl = controllers()
    if (!ctl || typeof ctl.fork !== 'function') {
      return { ok: false, error: 'sessionController.fork is unavailable in this composition' }
    }
    let forkedId
    try {
      const v = await ctl.fork({ sessionId, ...(Number.isFinite(atSeq) ? { atSeq } : {}) })
      forkedId = v && v.sessionId
      if (!forkedId) return { ok: false, error: 'fork returned no session id' }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) }
    }
    const t = typeof title === 'string' ? title.trim() : ''
    if (t && typeof ctl.rename === 'function') {
      try { await ctl.rename({ sessionId: forkedId, title: str(t, LIMITS.titleChars) }) } catch { /* title is cosmetic */ }
    }
    let prompted = false
    let promptError
    const text = typeof firstMessage === 'string' ? firstMessage.trim() : ''
    if (text) {
      const p = await promptSession({ sessionId: forkedId, text })
      prompted = p.ok
      if (!p.ok) promptError = p.error
    }
    cache.at = 0 // the next catalog read must include the new chat
    return { ok: true, sessionId: forkedId, prompted, ...(promptError ? { promptError } : {}) }
  }

  /** Send text into a session. Cold sessions resume through the controller.
   * Named promptSession: spawn()'s `prompt` parameter would shadow a plain
   * `prompt` name inside spawn(). */
  async function promptSession({ sessionId, text }) {
    const message = str(text, cfgOf().agents.promptMaxChars)
    if (!message.trim()) return { ok: false, error: 'message must be non-empty' }
    // 1) live agent: the supported inbox primitive (no resume needed).
    if (ctx.agents && typeof ctx.agents.get === 'function') {
      const agent = ctx.agents.get(sessionId)
      if (agent && typeof agent.followup === 'function') {
        try {
          agent.followup(pluginMessage(message, 'dsh-conductor'))
          return { ok: true, via: 'followup' }
        } catch (e) {
          return { ok: false, error: 'followup threw: ' + String(e && e.message || e) }
        }
      }
    }
    // 2) cold session: the controller resumes it, then admits the prompt.
    const ctl = controllers()
    if (!ctl || typeof ctl.prompt !== 'function') {
      return { ok: false, error: 'chat is not live and sessionController.prompt is unavailable' }
    }
    try {
      await ctl.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: message }],
      }, AbortSignal.timeout(30000))
      return { ok: true, via: 'controller' }
    } catch (e) {
      const name = String((e && (e.name || (e.constructor && e.constructor.name))) || '')
      if (name.includes('NotFound')) return { ok: false, error: 'chat-not-found', notFound: true }
      return { ok: false, error: String(e && e.message || e) }
    }
  }

  async function cancel(sessionId) {
    const ctl = controllers()
    if (!ctl || typeof ctl.cancel !== 'function') {
      const agent = ctx.agents && ctx.agents.get(sessionId)
      if (agent && typeof agent.cancel === 'function') {
        try { agent.cancel(); return { ok: true } } catch (e) { return { ok: false, error: String(e && e.message || e) } }
      }
      return { ok: false, error: 'no cancellation seam available' }
    }
    try {
      await ctl.cancel({ sessionId })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) }
    }
  }

  async function status(sessionId) {
    const cat = await catalog()
    const row = cat.rows.find((r) => r.sessionId === sessionId) || null
    const agent = ctx.agents && typeof ctx.agents.get === 'function' ? ctx.agents.get(sessionId) : undefined
    let lastAssistant = ''
    let lastAssistantAt = 0
    let lastUser = ''
    let lastTurnEnd = null
    let transcriptError
    try {
      const t = await transcript(sessionId, { maxMessages: 6 })
      for (const m of t.messages) {
        if (m.role === 'assistant' && m.text) { lastAssistant = m.text; lastAssistantAt = m.time || 0 }
        if (m.role === 'user' && m.text) lastUser = m.text
      }
      lastTurnEnd = t.lastTurnEnd || null
      if (t.error) transcriptError = t.error
    } catch (e) { transcriptError = String(e && e.message || e) }
    return {
      sessionId,
      title: (row && row.title) || '',
      origin: (row && row.origin) || 'chat',
      live: Boolean(agent),
      running: Boolean(agent && agent.status === 'running'),
      status: agent ? String(agent.status || 'live') : 'cold',
      cwd: (row && row.cwd) || '',
      updatedAt: (row && row.updatedAt) || (row && row.createdAt) || 0,
      lastUser: lastUser.slice(0, 400),
      lastAssistant: lastAssistant.slice(0, 2000),
      lastAssistantAt,
      lastTurnEnd,
      ...(transcriptError ? { transcriptError } : {}),
    }
  }

  /**
   * Chat-style transcript: newest N surface messages, derived from the
   * controller's message-aligned history page.
   */
  async function transcript(sessionId, { maxMessages } = {}) {
    const ctl = controllers()
    if (!ctl || typeof ctl.page !== 'function') {
      return { sessionId, messages: [], error: 'sessionController.page is unavailable' }
    }
    const cap = Math.min(Math.max(5, Number(maxMessages) || cfgOf().agents.transcriptMax), 500)
    try {
      // page() needs throughSeq <= the session's current cursor, and the
      // controller exposes no cheap cursor query. Its bad-request error names
      // the true cursor ("... is past cursor N"), so: ask for the latest
      // window, read N from that one well-defined rejection, retry once.
      const readPage = (throughSeq) => ctl.page({
        address: { kind: 'session', sessionId },
        throughSeq,
        maxMessages: cap,
      }, AbortSignal.timeout(15000))
      let v
      try {
        v = await readPage(Number.MAX_SAFE_INTEGER)
      } catch (e) {
        const m = /past cursor (-?\d+)/.exec(String(e && e.message || e))
        if (!m) throw e
        const cursor = Number(m[1])
        if (cursor < 0) return { sessionId, messages: [], lastTurnEnd: null, truncated: false }
        v = await readPage(cursor)
      }
      const messages = []
      let lastTurnEnd = null
      for (const wrapped of (v && v.records) || []) {
        // page() records are wrappers: { type: 'event', event: <log event> }
        // (entryFor in the controller). Accept a bare event too.
        const rec = wrapped && wrapped.type === 'event' && wrapped.event ? wrapped.event : wrapped
        if (!rec || typeof rec.type !== 'string') continue
        if (rec.type === 'turn/end') {
          const reason = rec.data && rec.data.reason
          const kind = reason && typeof reason.kind === 'string' ? reason.kind : 'unknown'
          const errMsg = reason && reason.error && typeof reason.error.message === 'string' ? reason.error.message : ''
          lastTurnEnd = { seq: rec.seq, time: rec.time, kind, ...(errMsg ? { error: errMsg.slice(0, 400) } : {}) }
          continue
        }
        if (rec.type === 'user/message') {
          const text = contentText(rec.data && rec.data.content)
          if (text) messages.push({ role: 'user', seq: rec.seq, time: rec.time, text: text.slice(0, cfgOf().agents.transcriptTailChars * 4) })
        } else if (rec.type === 'assistant/message') {
          const text = contentText(rec.data && rec.data.message && rec.data.message.content)
          if (text) messages.push({ role: 'assistant', seq: rec.seq, time: rec.time, text: text.slice(0, cfgOf().agents.transcriptTailChars * 4) })
        }
      }
      return { sessionId, messages: messages.slice(-cap), lastTurnEnd, truncated: Boolean(v && v.hasMore) }
    } catch (e) {
      return { sessionId, messages: [], error: String(e && e.message || e) }
    }
  }

  return { catalog, resolveRef, spawn, fork, prompt: promptSession, cancel, status, transcript }
}

/** Pull the text out of a ContentBlock[]-shaped value, defensively. */
export function contentText(blocks) {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') out += (out ? '\n' : '') + b.text
  }
  return out.trim()
}

export const __agents = { pluginMessage, PREFIX_MIN_LEN }
