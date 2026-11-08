/**
 * dsh-conductor - the task engine.
 *
 * Task types (all operator-visible, all status-tracked, all cancel-safe):
 *
 *   command  run a shell command on a runner (local | ssh | http tool server)
 *   scrape   DETERMINISTIC scrape: fetch URL(s), extract text / html /
 *            attribute / regex - no model in the loop, ever
 *   http     call an endpoint, record status + body (the "software glue" task)
 *   agent    spawn or drive an agent chat; its output is the chat itself
 *            (chat-style status + updates while it runs)
 *
 * Lifecycle: queued -> running -> completed | failed | cancelled ( |
 * interrupted at boot). A global concurrency cap queues overflow; every
 * transition is appended to the event log and persisted atomically.
 *
 * Agent tasks settle by polling the agent facade: a spawned chat is "done"
 * when it stops running AND has produced an assistant message after the
 * spawn prompt; the task output carries that message (chat style, updated
 * live). Cancelling cancels the agent's active turn.
 *
 * Best-effort mirror into ctx.jobs so tasks also appear in the built-in
 * Background Tasks surface; any failure flips the mirror off permanently.
 */

'use strict'

import { LIMITS, str, mintId, isSafeId } from './core.js'
import { runOnRunner, runViaToolServer, pickRunner } from './runners.js'

export const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted']

export class TaskEngine {
  constructor(cfg, store, agents, { log = () => {}, warn = () => {}, now = () => Date.now() } = {}) {
    this.cfg = cfg
    this.store = store
    this.agents = agents
    this.log = log
    this.warn = warn
    this.now = now
    this.live = new Set()
    this.queue = []
    this.jobs = null
    this.jobsAvailable = null
    this.pollTimers = new Map()
    this.cancels = new Map()
    this.runners = () => cfg.runners
  }

  async boot() {
    await this.store.init()
    let reaped = 0
    for (const t of this.store.list()) {
      if (t.status === 'running' || t.status === 'queued') {
        t.status = 'interrupted'
        t.finishedAt = this.now()
        t.detail = 'interrupted by a dsh-web restart'
        this.store.upsert(t)
        reaped += 1
      }
    }
    await this.store.flush()
    if (reaped) this.log('boot: reaped ' + reaped + ' interrupted task(s)')
  }

  /**
   * Create a task. opts.ownerSession stamps the creating session (tool exec
   * context, tab scope, or API caller) so views can filter 'this chat' vs 'all'.
   */
  async create(spec, opts = {}) {
    if (!spec || typeof spec !== 'object') return { ok: false, error: 'spec must be an object' }
    const type = String(spec.type || '')
    if (!['command', 'scrape', 'http', 'agent'].includes(type)) {
      return { ok: false, error: 'type must be one of command | scrape | http | agent' }
    }
    const title = str(spec.title, LIMITS.titleChars).trim()
    const runnerId = str(spec.runner, LIMITS.idChars).trim() || 'auto'
    let config = {}
    if (type === 'command') {
      if (this.cfg.tasks.allowCommandTasks === false) {
        return { ok: false, error: 'command tasks are disabled in settings (tasks.allowCommandTasks)' }
      }
      const command = str(spec.command, LIMITS.commandChars)
      if (!command.trim()) return { ok: false, error: 'command must be non-empty' }
      config = {
        command,
        cwd: str(spec.cwd, 4096).trim() || '/',
        timeoutMs: Number.isFinite(spec.timeoutMs)
          ? Math.min(Math.max(500, Math.floor(spec.timeoutMs)), this.cfg.tasks.commandTimeoutMs * 4)
          : this.cfg.tasks.commandTimeoutMs,
      }
    } else if (type === 'scrape') {
      const urls = (Array.isArray(spec.urls) ? spec.urls : [spec.url])
        .map((u) => str(u, LIMITS.urlChars).trim())
        .filter((u) => /^https?:\/\//i.test(u))
        .slice(0, this.cfg.tasks.scrapeMaxUrls)
      if (!urls.length) return { ok: false, error: 'at least one http(s) url is required' }
      const extract = ['text', 'html', 'json'].includes(spec.extract) ? spec.extract : 'text'
      const selector = str(spec.selector, 500).trim()
      const attribute = str(spec.attribute, 120).trim()
      const pattern = str(spec.pattern, 500).trim()
      if (pattern) {
        try { new RegExp(pattern, 'u') } catch (e) { return { ok: false, error: 'invalid pattern: ' + String(e && e.message || e) } }
      }
      config = {
        urls,
        extract,
        selector,
        attribute,
        pattern,
        timeoutMs: Number.isFinite(spec.timeoutMs)
          ? Math.min(Math.max(500, Math.floor(spec.timeoutMs)), this.cfg.tasks.scrapeTimeoutMs * 4)
          : this.cfg.tasks.scrapeTimeoutMs,
        maxBytes: this.cfg.tasks.scrapeMaxBytes,
      }
    } else if (type === 'http') {
      const url = str(spec.url, LIMITS.urlChars).trim()
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url must be http(s)' }
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(String(spec.method).toUpperCase())
        ? String(spec.method).toUpperCase() : 'GET'
      config = {
        url,
        method,
        body: typeof spec.body === 'string' ? spec.body.slice(0, 64 * 1024) : (spec.body === undefined ? '' : JSON.stringify(spec.body).slice(0, 64 * 1024)),
        headers: sanitizeHeaders(spec.headers),
        expectStatus: Number.isFinite(spec.expectStatus) ? Math.floor(spec.expectStatus) : 0,
        timeoutMs: Number.isFinite(spec.timeoutMs)
          ? Math.min(Math.max(500, Math.floor(spec.timeoutMs)), this.cfg.tasks.httpTimeoutMs * 4)
          : this.cfg.tasks.httpTimeoutMs,
      }
    } else if (type === 'agent') {
      const prompt = str(spec.prompt, this.cfg.agents.promptMaxChars)
      if (!prompt.trim()) return { ok: false, error: 'agent tasks need a prompt' }
      config = {
        prompt,
        title: title || str(spec.agentTitle, LIMITS.titleChars).trim(),
        preset: str(spec.preset, 120).trim(),
        cwd: str(spec.cwd, 4096).trim(),
        forkOf: str(spec.forkOf, LIMITS.idChars).trim(),
        count: Math.min(Math.max(1, Number(spec.count) || 1), this.cfg.agents.spawnMax),
        promptExisting: str(spec.promptExisting, LIMITS.idChars).trim(),
      }
    }
    const task = {
      id: mintId(type.slice(0, 2)),
      type,
      title: title || defaultTitle(type, config),
      status: 'queued',
      createdAt: this.now(),
      startedAt: null,
      finishedAt: null,
      runner: type === 'agent' ? 'local' : runnerId,
      ownerSession: isSafeId(opts.ownerSession) ? opts.ownerSession : null,
      config,
      output: '',
      detail: '',
      via: '',
      result: null,
    }
    if (type !== 'agent') {
      const { runner, error } = pickRunner(this.runners(), runnerId, { defaultRunner: this.cfg.tasks.defaultRunner })
      if (!runner) return { ok: false, error: error || 'no runner' }
      if (runner.kind !== 'local' && this.cfg.tasks.allowRemoteRunners === false) {
        return { ok: false, error: 'remote runners are disabled in settings (tasks.allowRemoteRunners)' }
      }
      task.runner = runner.id
      task.via = runner.kind + ':' + runner.id
    }
    this.store.upsert(task)
    await this.store.appendEvent({ event: 'task-created', taskId: task.id, type, title: task.title })
    this.mirror(task)
    this.queue.push(task.id)
    this.pump()
    return { ok: true, task }
  }

  runningCount() {
    return this.store.list().filter((t) => t.status === 'running').length
  }

  pump() {
    while (this.queue.length && this.runningCount() < this.cfg.tasks.maxConcurrent) {
      const id = this.queue.shift()
      const task = this.store.get(id)
      if (!task || task.status !== 'queued') continue
      this.start(task)
    }
    for (const id of [...this.live]) {
      const t = this.store.get(id)
      if (!t) this.live.delete(id)
    }
  }

  async start(task) {
    task.status = 'running'
    task.startedAt = this.now()
    this.live.add(task.id)
    this.store.upsert(task)
    if (this.store.dirty) this.debounceFlush()
    void this.store.appendEvent({ event: 'task-started', taskId: task.id })
    if (task.type === 'agent') {
      void this.runAgentTask(task)
    } else {
      void this.runWorkTask(task)
    }
  }

  debounceFlush() {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.store.flush().catch(() => {})
    }, 500)
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
  }

  async runWorkTask(task) {
    const runner = this.runners().find((r) => r.id === task.runner)
    // Every work task gets a real stop handle: an AbortController for
    // http/scrape, replaced by the runner's process-group kill for commands.
    const abort = new AbortController()
    this.cancels.set(task.id, () => abort.abort())
    try {
      let r
      if (task.type === 'command') {
        r = await runOnRunner(runner, task.config.command, {
          cwd: task.config.cwd,
          timeoutMs: task.config.timeoutMs,
          // LIVE OUTPUT: chunks land in the task record as they arrive, so
          // /tasks/:id/output shows progress while the command runs.
          onChunk: (text) => this.appendLiveOutput(task, text),
          onStart: (kill) => {
            this.cancels.set(task.id, kill)
            // cancelled before the process even started: stop it right away
            if (abort.signal.aborted) kill()
          },
        })
      } else if (task.type === 'http') {
        r = await this.httpOnce(task.config, { signal: abort.signal })
      } else if (task.type === 'scrape') {
        r = await this.scrapeOnce(task.config, {
          onUrl: (line) => this.appendLiveOutput(task, line),
          signal: abort.signal,
        })
      } else {
        r = { ok: false, status: 'failed', detail: 'unknown type' }
      }
      // Cancelled while running: the cancel path already settled the record;
      // a late runner result must not overwrite 'cancelled (...)'.
      if (TERMINAL.includes(task.status)) return
      const output = composeOutput(r, this.cfg.tasks.maxOutputBytes)
      task.output = output
      task.result = { status: r.ok ? 'completed' : 'failed', detail: r.detail || r.status || '', via: r.via || task.via }
      task.detail = task.result.detail
      task.via = r.via || task.via
      this.settle(task, r.ok ? 'completed' : 'failed')
    } catch (e) {
      if (TERMINAL.includes(task.status)) return
      task.output = task.output || ''
      task.result = { status: 'failed', detail: String(e && e.message || e), via: task.via }
      task.detail = task.result.detail
      this.settle(task, 'failed')
    }
  }

  /** Append a live output chunk to a running task (capped, debounced flush). */
  appendLiveOutput(task, text) {
    if (typeof text !== 'string' || text === '') return
    if (TERMINAL.includes(task.status)) return
    const cap = this.cfg.tasks.maxOutputBytes
    const current = typeof task.output === 'string' ? task.output : ''
    task.output = (current + text).slice(0, cap)
    task.detail = 'running - ' + task.output.length + ' bytes of output'
    this.store.upsert(task)
    this.debounceFlush()
  }

  async httpOnce({ url, method, headers, body, expectStatus, timeoutMs }, { signal } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs))
    const onCancel = () => controller.abort()
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onCancel, { once: true }) }
    try {
      const res = await fetch(url, {
        method,
        headers: { ...headers, ...((body && method !== 'GET' && method !== 'HEAD') ? { 'content-type': 'application/json' } : {}) },
        body: (method === 'GET' || method === 'HEAD') ? undefined : (body || undefined),
        signal: controller.signal,
        redirect: 'follow',
      })
      const text = method === 'HEAD' ? '' : await res.text()
      const ok = expectStatus ? res.status === expectStatus : res.ok
      return {
        ok,
        status: 'http ' + res.status,
        detail: 'HTTP ' + res.status + (expectStatus ? ' (expected ' + expectStatus + ')' : ''),
        stdout: text.slice(0, this.cfg.tasks.maxOutputBytes),
        stderr: '',
        via: 'http-fetch',
      }
    } catch (e) {
      const aborted = e && e.name === 'AbortError'
      const cancelled = Boolean(signal && signal.aborted)
      return { ok: false, status: cancelled ? 'cancelled' : aborted ? 'timeout' : 'unreachable', detail: cancelled ? 'cancelled' : aborted ? 'timeout after ' + timeoutMs + 'ms' : String(e && e.message || e), stdout: '', stderr: '' }
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onCancel)
    }
  }

  async scrapeOnce({ urls, extract, selector, attribute, pattern, timeoutMs, maxBytes }, { onUrl, signal } = {}) {
    const rows = []
    let allOk = true
    let n = 0
    for (const url of urls) {
      if (signal && signal.aborted) { allOk = false; break }
      const row = { url }
      n += 1
      if (typeof onUrl === 'function') { try { onUrl('[' + n + '/' + urls.length + '] ' + url + ' ...' + String.fromCharCode(10)) } catch { /* progress is advisory */ } }
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs))
        const onCancel = () => controller.abort()
        if (signal) signal.addEventListener('abort', onCancel, { once: true })
        let res
        try {
          res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
          const text = await res.text()
          row.status = res.status
          row.ok = res.ok
          if (!res.ok) allOk = false
          row.data = extractData(text, { extract, selector, attribute, pattern, maxBytes })
        } finally {
          clearTimeout(timer)
          if (signal) signal.removeEventListener('abort', onCancel)
        }
      } catch (e) {
        row.ok = false
        row.status = signal && signal.aborted ? 'cancelled' : e && e.name === 'AbortError' ? 'timeout' : 'error'
        row.error = String(e && e.message || e).slice(0, 300)
        allOk = false
      }
      if (typeof onUrl === 'function') { try { onUrl('[' + n + '/' + urls.length + '] ' + url + ' -> ' + String(row.status) + (row.ok ? '' : ' FAILED') + String.fromCharCode(10)) } catch { /* advisory */ } }
      rows.push(row)
    }
    const out = JSON.stringify({ rows }, null, 2)
    return {
      ok: allOk,
      status: 'scraped ' + rows.length + ' url(s)',
      detail: rows.filter((r) => !r.ok).length + '/' + rows.length + ' failed',
      stdout: out.slice(0, this.cfg.tasks.maxOutputBytes),
      stderr: '',
      via: 'scrape',
    }
  }

  // ── agent execution (chat-style) ──────────────────────────────────────────

  async runAgentTask(task) {
    const c = task.config
    try {
      if (c.promptExisting) {
        const ref = await this.agents.resolveRef(c.promptExisting)
        if (ref.kind === 'exact' || ref.kind === 'prefix' || ref.kind === 'title') {
          const r = await this.agents.prompt({ sessionId: ref.id, text: c.prompt })
          if (!r.ok) throw new Error(r.error)
          task.agentSessionId = ref.id
          task.detail = 'prompting existing chat ' + ref.id
        } else {
          throw new Error('agent reference not found: ' + (ref.reason || ref.kind))
        }
      } else if (c.forkOf) {
        const ref = await this.agents.resolveRef(c.forkOf)
        if (ref.kind !== 'exact' && ref.kind !== 'prefix' && ref.kind !== 'title') {
          throw new Error('agent reference not found: ' + (ref.reason || ref.kind))
        }
        const f = await this.agents.fork(ref.id, { prompt: c.prompt, title: c.title })
        if (!f.ok) throw new Error(f.error)
        if (!f.prompted) throw new Error('fork prompt: ' + (f.promptError || 'not delivered'))
        task.agentSessionId = f.sessionId
        task.detail = 'forked from ' + ref.id
      } else {
        const s = await this.agents.spawn({ title: c.title, prompt: c.prompt, preset: c.preset, cwd: c.cwd, count: c.count })
        if (!s.ok || !s.created.length) throw new Error((s.failures && s.failures[0]) || 'spawn failed')
        task.agentSessionId = s.created[0].sessionId
        task.agentSessionIds = s.created.map((x) => x.sessionId)
        task.detail = 'spawned ' + s.created.length + ' chat(s)'
      }
      this.store.upsert(task)
      this.settleLaterWhenIdle(task)
    } catch (e) {
      task.result = { status: 'failed', detail: String(e && e.message || e), via: 'agent' }
      task.detail = task.result.detail
      this.settle(task, 'failed')
    }
  }

  /** Poll the spawned chat; settle when it stops running with fresh output. */
  settleLaterWhenIdle(task) {
    const poll = async () => {
      try {
        if (TERMINAL.includes(task.status)) return
        const st = await this.agents.status(task.agentSessionId)
        if (TERMINAL.includes(task.status)) return
        // Freshness: only activity AFTER this task started counts. Prompting an
        // existing chat must not 'complete' on an answer from an earlier turn.
        const since = task.startedAt || 0
        const freshAnswer = Boolean(st.lastAssistant) && (st.lastAssistantAt || 0) >= since
        const te = st.lastTurnEnd && (st.lastTurnEnd.time || 0) >= since ? st.lastTurnEnd : null
        task.runningAgent = st.running
        task.detail = (st.running ? 'agent is working' : 'agent is idle') + (st.title ? ' - ' + st.title : '')
        if (freshAnswer) task.output = 'assistant: ' + st.lastAssistant
        this.store.upsert(task)
        if (!st.running) {
          if (freshAnswer && !(te && te.kind === 'error' && te.time > (st.lastAssistantAt || 0))) {
            task.result = { status: 'completed', detail: 'agent answered', via: 'agent' }
            task.detail = task.result.detail
            this.settle(task, 'completed')
            return
          }
          if (te && te.kind === 'error') {
            // the model turn failed (no adapter, auth, quota, ...): say so now
            task.result = { status: 'failed', detail: 'agent turn failed: ' + (te.error || 'unknown error'), via: 'agent' }
            task.detail = task.result.detail
            this.settle(task, 'failed')
            return
          }
          if (te) {
            // the turn ended cleanly but produced no text (tool-only turn)
            task.result = { status: 'completed', detail: 'agent turn ended (' + te.kind + ') without a text answer', via: 'agent' }
            task.detail = task.result.detail
            this.settle(task, 'completed')
            return
          }
          // idle and no fresh turn has ended yet: the prompt may still be
          // queued. Give it a bounded grace window, then report honestly.
          const age = this.now() - since
          if (age > 5 * 60 * 1000) {
            task.result = { status: 'failed', detail: 'agent stayed idle for 5 minutes without starting a turn', via: 'agent' }
            task.detail = task.result.detail
            this.settle(task, 'failed')
            return
          }
        }
        this.schedulePoll(task, poll)
      } catch (e) {
        task.result = { status: 'failed', detail: 'poll: ' + String(e && e.message || e), via: 'agent' }
        this.settle(task, 'failed')
      }
    }
    this.schedulePoll(task, poll)
  }

  schedulePoll(task, poll) {
    const t = setTimeout(() => { this.pollTimers.delete(task.id); void poll() }, this.cfg.tasks.pollMs)
    this.pollTimers.set(task.id, t)
    if (typeof t.unref === 'function') t.unref()
  }

  // ── reads / control ───────────────────────────────────────────────────────

  list({ status, type, owner, limit } = {}) {
    let rows = this.store.list()
    if (status) rows = rows.filter((t) => t.status === status)
    if (type) rows = rows.filter((t) => t.type === type)
    if (owner) rows = rows.filter((t) => t.ownerSession === owner || t.agentSessionId === owner)
    rows = rows.slice().reverse()
    if (Number.isFinite(limit)) rows = rows.slice(0, Math.max(1, Math.min(500, limit)))
    return rows.map((t) => publicTask(t))
  }

  get(id) {
    const t = this.store.get(id)
    return t ? publicTask(t) : null
  }

  output(id, { tail } = {}) {
    const t = this.store.get(id)
    if (!t) return { ok: false, error: 'no such task: ' + String(id) }
    const text = typeof t.output === 'string' ? t.output : ''
    const n = Number.isFinite(tail) ? Math.max(100, Math.min(200000, tail)) : 200000
    return { ok: true, taskId: t.id, status: t.status, output: text.slice(-n), truncated: text.length > n }
  }

  async cancel(id, reason = 'operator') {
    const task = this.store.get(String(id))
    if (!task) return { ok: false, error: 'no such task: ' + String(id) }
    if (TERMINAL.includes(task.status)) return { ok: false, already: true, status: task.status }
    // Re-entry guard: a stop handle (or the jobs surface) may call back into
    // cancel() while we are inside it - never recurse.
    if (!this.cancelling) this.cancelling = new Set()
    if (this.cancelling.has(task.id)) return { ok: true, pending: true }
    this.cancelling.add(task.id)
    try {
      return await this.cancelInner(task, reason)
    } finally {
      this.cancelling.delete(task.id)
    }
  }

  async cancelInner(task, reason) {
    // a queued task never started: just drop it from the queue
    this.queue = this.queue.filter((qid) => qid !== task.id)
    const cancelFn = this.cancels.get(task.id)
    this.cancels.delete(task.id)
    if (typeof cancelFn === 'function') { try { cancelFn() } catch { /* idempotent */ } }
    if (task.type === 'agent' && task.agentSessionId) {
      await this.agents.cancel(task.agentSessionId).catch(() => {})
    }
    if (this.pollTimers.has(task.id)) {
      clearTimeout(this.pollTimers.get(task.id))
      this.pollTimers.delete(task.id)
    }
    task.result = task.result || { status: 'cancelled', detail: '', via: task.via }
    task.result.status = 'cancelled'
    task.detail = 'cancelled (' + reason + ')'
    this.settle(task, 'cancelled')
    return { ok: true }
  }

  // ── settlement + persistence ──────────────────────────────────────────────

  settle(task, status) {
    if (TERMINAL.includes(task.status)) return
    task.status = status
    task.finishedAt = this.now()
    this.live.delete(task.id)
    this.cancels.delete(task.id)
    if (this.pollTimers.has(task.id)) {
      clearTimeout(this.pollTimers.get(task.id))
      this.pollTimers.delete(task.id)
    }
    this.store.upsert(task)
    void this.store.appendEvent({ event: 'task-' + status, taskId: task.id, detail: String(task.detail || '').slice(0, 200) })
    void this.store.flush().catch(() => {})
    this.pump()
  }

  // ── ctx.jobs mirror (best effort) ─────────────────────────────────────────

  jobsMirrorEnabled() {
    if (this.cfg.mirrorJobs !== true) return false
    if (this.jobsAvailable === false) return false
    if (this.jobs === null) {
      this.jobs = (this.jobsLookup && this.jobsLookup()) || null
    }
    return Boolean(this.jobs && typeof this.jobs.start === 'function')
  }

  setJobsLookup(fn) { this.jobsLookup = fn }

  mirror(task) {
    if (!this.jobsMirrorEnabled()) return
    try {
      const engine = this
      const id = this.jobs.start({
        kind: 'orchestrator',
        label: task.title + ' [' + task.type + ']',
        run() {
          // NOTE: do not register anything in engine.cancels here - that map
          // holds the REAL stop handle (process kill / request abort). The jobs
          // surface cancels through cancel() below, which is re-entry guarded.
          return {
            cancel() { try { engine.cancel(task.id, 'jobs') } catch { /* idempotent */ } },
            done: engine.waitSettled(task.id),
            readOutput() {
              const t = engine.store.get(task.id)
              const whole = String((t && t.output) || '')
              const delta = whole.slice((task._jobCursor || 0))
              task._jobCursor = whole.length
              return delta
            },
          }
        },
      })
      task._jobId = id
      this.store.upsert(task)
    } catch (e) {
      this.jobsAvailable = false
      this.log('jobs mirror disabled: ' + String(e && e.message || e))
    }
  }

  waitSettled(taskId) {
    return new Promise((resolve) => {
      const check = () => {
        const t = this.store.get(taskId)
        if (t && TERMINAL.includes(t.status)) {
          resolve({
            status: t.status === 'completed' ? 'completed' : t.status === 'cancelled' ? 'killed' : 'failed',
            detail: t.detail || undefined,
            output: t.type === 'agent' ? undefined : String(t.output || '').slice(0, 512),
          })
          return
        }
        // Reffed on purpose: this promise must resolve, so it may hold the
        // loop open until settlement (the api contract depends on it).
        setTimeout(check, 250)
      }
      check()
    })
  }

  /** The tool-server contract shape: wait for settlement, then answer. */
  async waitSettledPublic(taskId, { maxWaitMs = 15 * 60 * 1000 } = {}) {
    const timer = new Promise((resolve) => {
      const t = setTimeout(() => resolve({ timeout: true }), maxWaitMs)
      if (typeof t.unref === 'function') t.unref()
    })
    const task = this.store.get(taskId)
    const settled = await Promise.race([this.waitSettled(taskId), timer])
    if (settled && settled.timeout) {
      return {
        ok: false,
        status: 'timeout',
        detail: 'task still running after ' + maxWaitMs + 'ms - poll /tasks/' + taskId,
        taskId,
      }
    }
    return {
      ok: settled.status === 'completed',
      status: settled.status,
      detail: settled.detail || '',
      output: String((task && task.output) || '').slice(0, this.cfg.tasks.maxOutputBytes),
      taskId,
    }
  }
}

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {}
  const out = {}
  for (const [k, v] of Object.entries(headers).slice(0, 20)) {
    const name = String(k).toLowerCase()
    if (!/^[a-z0-9-]+$/.test(name) || name === 'host' || name === 'content-length' || name.startsWith('sec-')) continue
    if (typeof v === 'string' && v.length <= 2000) out[name] = v
  }
  return out
}

function defaultTitle(type, config) {
  if (type === 'command') return '$ ' + String(config.command || '').slice(0, 60)
  if (type === 'scrape') return 'scrape ' + (config.urls || []).length + ' url(s)'
  if (type === 'http') return config.method + ' ' + String(config.url || '').slice(0, 60)
  if (type === 'agent') return 'agent: ' + String(config.prompt || '').slice(0, 60)
  return type
}

export function composeOutput(r, cap) {
  const parts = []
  if (r.stdout) parts.push(String(r.stdout))
  if (r.stderr) parts.push('--- stderr ---' + String.fromCharCode(10) + String(r.stderr))
  const text = parts.join(String.fromCharCode(10))
  if (text.length > cap) return text.slice(0, cap) + String.fromCharCode(10) + '...(truncated ' + (text.length - cap) + ' bytes)'
  return text
}

/**
 * Deterministic extraction from an HTML/text document.
 *   extract 'text' -> visible-ish text (tags stripped) or selector-scoped text
 *   extract 'html' -> raw document or selector-scoped html
 *   extract 'json' -> parse the body as JSON
 * selector: one simple compound token (tag, .class, #id, [attr]);
 * attribute: read that attribute off the matched element;
 * pattern: regex over the (possibly selector-scoped) text, all matches
 */
export function extractData(body, { extract = 'text', selector = '', attribute = '', pattern = '', maxBytes = 2 * 1024 * 1024 } = {}) {
  const doc = String(body || '').slice(0, maxBytes)
  let scope = doc
  if (selector) {
    const picked = selectFirst(doc, selector, attribute)
    scope = picked === null || picked === undefined ? '' : picked
  }
  let value
  if (extract === 'html') {
    value = scope
  } else if (extract === 'json') {
    try { value = JSON.parse(doc) } catch (e) { value = { error: 'not JSON: ' + String(e && e.message || e) } }
  } else {
    value = stripTags(scope)
  }
  if (pattern) {
    const matches = []
    const re = new RegExp(pattern, 'gu')
    let m
    const hay = typeof value === 'string' ? value : JSON.stringify(value)
    while ((m = re.exec(hay)) !== null && matches.length < 500) {
      matches.push(m.length > 1 ? m.slice(1) : m[0])
      if (m.index === re.lastIndex) re.lastIndex++
    }
    value = matches
  }
  if (typeof value === 'string') return value.slice(0, Math.floor(maxBytes / 2))
  const s = JSON.stringify(value)
  return s.length > Math.floor(maxBytes / 2) ? s.slice(0, Math.floor(maxBytes / 2)) : value
}

/**
 * Minimal, dependency-free first-match selector: one simple compound token
 * (tag, .class, #id, [attr], combinable). Intentionally NOT a CSS engine , 
 * deterministic scrapes want a small predictable surface, not a browser.
 */
export function selectFirst(html, selector, attribute = '') {
  const m = String(selector || '').trim().match(/^([a-zA-Z][a-zA-Z0-9-]*)?((?:[.#][A-Za-z0-9_-]+)*)((?:\[[^\]]+\])*)$/)
  if (!m) return null
  const tag = (m[1] || '').toLowerCase()
  const classes = []
  const ids = []
  for (const t of ((m[2] || '').match(/[.#][A-Za-z0-9_-]+/g) || [])) {
    if (t[0] === '.') classes.push(t.slice(1))
    else ids.push(t.slice(1))
  }
  const attrs = []
  for (const a of ((m[3] || '').match(/\[[^\]]+\]/g) || [])) {
    const inner = a.slice(1, -1)
    const eq = inner.indexOf('=')
    if (eq === -1) attrs.push({ name: inner.trim(), value: null })
    else attrs.push({ name: inner.slice(0, eq).trim(), value: inner.slice(eq + 1).replace(/^['"]|['"]$/g, '') })
  }
  const wantTag = tag || null
  const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr'])

  // Tokenizer: one pass over open AND close tags.
  const tokRe = /<(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)((?:[^<>]*?))(\/?)>/g
  let depth = 0
  let start = -1
  let openTag = ''
  let match
  while ((match = tokRe.exec(html)) !== null) {
    const closing = match[1] === '/'
    const t = match[2].toLowerCase()
    const rest = match[3] || ''
    const selfClose = match[4] === '/' || VOID.has(t)
    if (depth === 0) {
      if (closing) continue
      if (wantTag && t !== wantTag) continue
      if (classes.length && !classes.every((c) => classHas(attrOf(rest, 'class'), c))) continue
      if (ids.length && !ids.every((x) => attrOf(rest, 'id') === x)) continue
      if (attrs.length && !attrs.every((a) => {
        const v = attrOf(rest, a.name)
        return a.value === null ? v !== null : v === a.value
      })) continue
      if (attribute) {
        const v = attrOf(rest, attribute)
        return v === null ? null : v
      }
      if (selfClose) return match[0]
      start = match.index
      openTag = t
      depth = 1
    } else if (t === openTag) {
      if (closing || selfClose) depth -= 1
      else depth += 1
      if (depth <= 0) return html.slice(start, match.index + match[0].length)
    }
  }
  return null
}

function classHas(classAttr, c) {
  return String(classAttr || '').split(/\s+/).includes(c)
}

function attrOf(attrText, name) {
  const m = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(String(attrText || ''))
  if (!m) return null
  return m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4])
}

export function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function publicTask(t) {
  return {
    id: t.id,
    type: t.type,
    title: t.title,
    status: t.status,
    runner: t.runner,
    via: t.via,
    detail: t.detail,
    ownerSession: t.ownerSession || null,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    agentSessionId: t.agentSessionId || null,
    agentSessionIds: t.agentSessionIds || null,
    outputBytes: typeof t.output === 'string' ? t.output.length : 0,
    outputPreview: typeof t.output === 'string' ? t.output.slice(0, 600) : '',
    result: t.result || null,
  }
}

export const __tasks = { sanitizeHeaders, defaultTitle, TERMINAL }

