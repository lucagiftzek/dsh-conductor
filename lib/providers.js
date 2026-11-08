/**
 * dsh-conductor - provider adapters: external systems surfaced in the
 * Control tab with status cards.
 *
 *   kind 'hpc'   speaks the dsh-hpc plugin's own route shape:
 *                GET {url}/health -> {ok,...}, GET {url}/state -> the full
 *                grant summary. We surface the balance headline, collector
 *                health and staged-proposal count. Configure url to wherever
 *                dsh-hpc is mounted on that host (default route path
 *                /dsh-hpc/api) - nothing is assumed about the host itself.
 *   kind 'http'  a generic JSON status endpoint: GET {url} and show the
 *                fields it returns (ok/health/status/headline/summary keys
 *                are highlighted when present). Optional secretEnv names an
 *                environment variable read AT CALL TIME for a Bearer token,
 *                so credentials never live in settings.
 *
 * All reads are short-timeout, never throw, and are TTL-cached per provider
 * so the tab's poll loop stays cheap.
 */

'use strict'

export class Providers {
  /** cfg may be a resolved config OR a getter () => resolvedConfig (live). */
  constructor(cfgOrGetter, { log = () => {} } = {}) {
    this.cfgOf = typeof cfgOrGetter === 'function' ? cfgOrGetter : () => cfgOrGetter
    this.log = log
    this.cache = new Map() // id -> { at, data }
    this.inflight = new Map() // id -> Promise<data> (dedupes concurrent reads)
  }

  list() {
    return this.cfgOf().providers
  }

  /**
   * background: true -> never wait on a provider (the dashboard poll path):
   * return the last known card (flagged stale when due) and refresh behind
   * the scenes; the very first read yields a 'checking...' placeholder.
   * Otherwise all providers are read IN PARALLEL and awaited.
   */
  async statusAll({ maxAgeMs, background = false } = {}) {
    const ps = this.cfgOf().providers
    if (background) return ps.map((p) => this.peek(p, { maxAgeMs }))
    return Promise.all(ps.map((p) => this.status(p, { maxAgeMs })))
  }

  ttlOf(p, maxAgeMs) {
    return Math.min((p.pollSeconds || 60) * 1000, maxAgeMs || 15_000)
  }

  disabledCard(p) {
    return { id: p ? p.id : '?', kind: p ? p.kind : '?', label: p ? p.label : '?', enabled: false, ok: false, detail: 'disabled', at: 0 }
  }

  peek(p, { maxAgeMs = 0 } = {}) {
    if (!p || p.enabled === false) return this.disabledCard(p)
    const hit = this.cache.get(p.id)
    const due = !hit || Date.now() - hit.at >= this.ttlOf(p, maxAgeMs)
    if (due) void this.refresh(p).catch(() => {})
    if (hit) return due ? { ...hit.data, stale: true } : hit.data
    return { id: p.id, kind: p.kind, label: p.label, enabled: true, ok: null, pending: true, detail: 'checking...', at: 0 }
  }

  refresh(p) {
    const running = this.inflight.get(p.id)
    if (running) return running
    const job = (p.kind === 'hpc' ? readHpc(p) : readGeneric(p))
      .then((data) => { this.cache.set(p.id, { at: Date.now(), data }); return data })
      .finally(() => { this.inflight.delete(p.id) })
    this.inflight.set(p.id, job)
    return job
  }

  async status(p, { maxAgeMs = 0 } = {}) {
    if (!p || p.enabled === false) return this.disabledCard(p)
    const hit = this.cache.get(p.id)
    if (hit && Date.now() - hit.at < this.ttlOf(p, maxAgeMs)) return hit.data
    return this.refresh(p)
  }
}

async function fetchJson(url, { timeoutMs = 8000, secretEnv = '' } = {}) {
  const headers = { accept: 'application/json' }
  if (secretEnv && process.env[secretEnv]) {
    headers.authorization = 'Bearer ' + process.env[secretEnv]
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* non-JSON body */ }
    return { res, text, json }
  } finally {
    clearTimeout(timer)
  }
}

async function readHpc(p) {
  const base = { id: p.id, kind: 'hpc', label: p.label, enabled: true }
  try {
    const health = await fetchJson(p.url + '/health', { timeoutMs: 6000, secretEnv: p.secretEnv })
    if (!health.res.ok || !health.json || health.json.ok !== true) {
      return { ...base, ok: false, detail: 'health: HTTP ' + health.res.status, at: Date.now() }
    }
  } catch (e) {
    return { ...base, ok: false, detail: 'unreachable: ' + String(e && e.message || e).slice(0, 160), at: Date.now() }
  }
  try {
    const state = await fetchJson(p.url + '/state?logbook=0', { timeoutMs: 10000, secretEnv: p.secretEnv })
    if (!state.res.ok || !state.json) {
      return { ...base, ok: true, health: 'ok', detail: 'state: HTTP ' + state.res.status, at: Date.now() }
    }
    const j = state.json
    const staged = Array.isArray(j.staged) ? j.staged.length : 0
    const armed = Array.isArray(j.staged)
      ? j.staged.filter((s) => s && s.arm && s.arm.armed === true).length : 0
    return {
      ...base,
      ok: true,
      health: 'ok',
      headline: typeof j.headline === 'string' ? j.headline : '',
      balance: j.balance ? {
        gpuHoursLeft: j.balance.gpu_hours_left ?? j.balance.gpuHoursLeft ?? null,
        billingHoursLeft: j.balance.billing_hours_left ?? j.balance.billingHoursLeft ?? null,
        deadline: j.deadline ?? (j.balance && j.balance.deadline) ?? null,
      } : null,
      collector: j.collector ? { status: j.collector.status, checkedAt: j.collector.checked_at ?? null } : null,
      queue: j.queue ? { running: (j.queue.running || []).length, pending: (j.queue.pending || []).length } : null,
      staged,
      armed,
      detail: staged ? staged + ' proposal(s), ' + armed + ' armed' : 'no proposals staged',
      at: Date.now(),
    }
  } catch (e) {
    return { ...base, ok: true, health: 'ok', detail: 'state read failed: ' + String(e && e.message || e).slice(0, 160), at: Date.now() }
  }
}

async function readGeneric(p) {
  const base = { id: p.id, kind: 'http', label: p.label, enabled: true }
  try {
    const r = await fetchJson(p.url, { timeoutMs: 8000, secretEnv: p.secretEnv })
    if (!r.res.ok) {
      return { ...base, ok: false, detail: 'HTTP ' + r.res.status, at: Date.now() }
    }
    if (!r.json) {
      return { ...base, ok: true, detail: 'non-JSON body (' + r.text.slice(0, 120) + ')', at: Date.now() }
    }
    const j = r.json
    const ok = typeof j.ok === 'boolean' ? j.ok
      : typeof j.health === 'string' ? j.health === 'ok'
      : typeof j.status === 'string' ? ['ok', 'healthy', 'up', 'running'].includes(j.status.toLowerCase())
      : true
    return {
      ...base,
      ok,
      headline: firstString(j, ['headline', 'summary', 'message', 'detail', 'description']),
      fields: pickFields(j, ['ok', 'health', 'status', 'version', 'uptime', 'connected', 'jobs', 'agents', 'tasks', 'running', 'pending']),
      detail: firstString(j, ['headline', 'summary', 'message', 'status', 'detail']) || 'reachable',
      at: Date.now(),
    }
  } catch (e) {
    const aborted = e && e.name === 'AbortError'
    return { ...base, ok: false, detail: aborted ? 'timeout' : 'unreachable: ' + String(e && e.message || e).slice(0, 160), at: Date.now() }
  }
}

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k]
    if (typeof v === 'string' && v.trim()) return v.slice(0, 300)
  }
  return ''
}

function pickFields(obj, keys) {
  const out = {}
  for (const k of keys) {
    const v = obj && obj[k]
    if (v === undefined) continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = typeof v === 'string' ? v.slice(0, 120) : v
  }
  return out
}

export const __providers = { fetchJson }
