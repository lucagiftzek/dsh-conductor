/**
 * dsh-conductor - the HTTP surface.
 *
 * Two callers, two gates (see lib/security.js for the full model):
 *
 *   BROWSER (the sidebar tab + Settings section, same-origin fetch)
 *     GET  /health /status /agents /agents/:id /agents/:id/transcript
 *          /tasks /tasks/:id /tasks/:id/output /runners /providers
 *          /settings /logs
 *          -> trust fence (loopback peer + Host authority + no cross-site)
 *     POST/PUT /agents /agents/:id/prompt /agents/:id/cancel /agents/fork
 *          /tasks /tasks/:id/cancel /settings
 *     POST /secret
 *          -> browser mutation gate (trust + same-origin + CSRF headers +
 *             harness session cookie presence)
 *
 *   MACHINE (curl / cron / another box)
 *     The same routes, authenticated by x-conductor-secret (or Bearer),
 *     constant-time compared, rate-limited per IP, failing closed without a
 *     configured secret. Additionally the TOOL-SERVER contract:
 *     POST /remote/run  { kind, spec, timeoutMs } -> { ok, status, output, detail }
 *     which is exactly what an http RUNNER on another host calls, and
 *     POST /remote/prompt { chat, message } for the watchdog-style inject.
 *
 * No GET ever mutates. A machine secret presented on a browser-gated route
 * satisfies the machine path (strictly stronger evidence). Every mutating
 * action routes through the same engine the model tools use.
 */

'use strict'

import { LIMITS, PLUGIN_ID, VERSION, SECRET_ENV, safeSettings, sanitizeSettingsPatch, fingerprint, str } from './core.js'
import {
  checkReadRequest, checkBrowserMutation, secretEquals, presentedSecret, makeRateLimiter,
} from './security.js'
import { probeRunner } from './runners.js'

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(text)
}

async function readJsonBody(req, maxBytes = LIMITS.bodyBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be a JSON object')
  return value
}

/**
 * Build the route handler.
 * deps: { engine, agents, providers, effective, persistSettingsPatch, log }
 * effective() returns the CURRENT resolved config; persistSettingsPatch
 * writes through the settings service (or fallback file).
 */
export function makeHandler(cfg, deps = {}) {
  const engine = deps.engine
  const agents = deps.agents
  const providers = deps.providers
  const effective = deps.effective || (() => cfg)
  const persistSettingsPatch = deps.persistSettingsPatch || (async () => {})
  const log = deps.log || (() => {})
  const warn = deps.warn || log
  const rateLimiter = makeRateLimiter(() => effective().api.rateLimitPerMinute)
  const authFailLimiter = makeRateLimiter(() => 10)
  const probes = new Map() // runner id -> { at, data }

  const machineSecret = () => {
    const c = effective()
    return String((process.env[SECRET_ENV] || '').trim() || c.api.secret || (process.env.DSH_ORCHESTRATOR_SECRET || '').trim() || '')
  }

  const secretHeaderName = 'x-conductor-secret'

  async function probeRunnerCached(runner, { force = false } = {}) {
    const hit = probes.get(runner.id)
    if (!force && hit && Date.now() - hit.at < 30_000) return hit.data
    const data = await probeRunner(runner)
    probes.set(runner.id, { at: Date.now(), data })
    return data
  }

  return async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://orchestrator.local')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    // the legacy prefix /dsh-orchestrator/api is served too when legacyRoute is on
    const prefix = ['/' + PLUGIN_ID + '/api', '/dsh-orchestrator/api'].find((p) => path === p || path.startsWith(p + '/'))
    const sub = prefix ? path.slice(prefix.length) || '/' : path

    try {
      const method = req.method || 'GET'

      // ── machine-secret path ────────────────────────────────────────────
      const secret = machineSecret()
      const presented = presentedSecret(req.headers, secretHeaderName) || presentedSecret(req.headers, 'x-orchestrator-secret')
      if (presented !== '') {
        if (secret === '') {
          sendJson(res, 503, { ok: false, error: 'secret-not-configured', hint: 'set ' + SECRET_ENV + ' or save a secret in Settings' })
          return
        }
        if (!secretEquals(presented, secret)) {
          const ip = (req.socket && req.socket.remoteAddress) || 'unknown'
          const af = authFailLimiter.take(ip)
          if (!af.ok) res.setHeader('retry-after', String(Math.ceil(af.retryAfterMs / 1000)))
          sendJson(res, af.ok ? 401 : 429, { ok: false, error: af.ok ? 'invalid-secret' : 'rate-limited', retryAfterMs: af.retryAfterMs })
          return
        }
        const ip = (req.socket && req.socket.remoteAddress) || 'unknown'
        const rl = rateLimiter.take(ip)
        if (!rl.ok) {
          res.setHeader('retry-after', String(Math.ceil(rl.retryAfterMs / 1000)))
          sendJson(res, 429, { ok: false, error: 'rate-limited', retryAfterMs: rl.retryAfterMs })
          return
        }
        let body = null
        if (method === 'POST' || method === 'PUT') {
          body = await readJsonBody(req)
        }
        await route(sub, method, req, res, { machine: true, body })
        return
      }

      // ── browser path ───────────────────────────────────────────────────
      // Every POST/PUT is a mutation and takes the browser mutation gate;
      // every GET/HEAD is a read and takes the read fence. No GET mutates,
      // no POST reads.
      const isMutation = method === 'POST' || method === 'PUT'
      if (isMutation) {
        const gate = checkBrowserMutation(req, {
          trustedHosts: effective().trustedHosts,
          requireCookie: effective().requireHarnessCookie,
          pluginId: PLUGIN_ID,
        })
        if (!gate.ok) {
          sendJson(res, gate.status, { ok: false, error: gate.reason, layer: gate.layer })
          return
        }
        const body = await readJsonBody(req)
        await route(sub, method, req, res, { machine: false, body })
        return
      }
      const gate = checkReadRequest(req, { trustedHosts: effective().trustedHosts })
      if (!gate.ok) {
        sendJson(res, gate.status, { ok: false, error: gate.reason })
        return
      }
      await route(sub, method, req, res, { machine: false, body: null })
    } catch (error) {
      try {
        if (res.headersSent) { res.end(); return }
        sendJson(res, 500, { ok: false, error: String(error && error.message || error) })
      } catch { /* socket gone */ }
    }

    // ── the actual routes ────────────────────────────────────────────────
    async function route(sub2, method, req, res, { machine, body }) {
      const c = effective()
      const secret = machineSecret()

      if (method === 'GET' && (sub2 === '/health' || sub2 === '/')) {
        sendJson(res, 200, {
          ok: true, plugin: PLUGIN_ID, version: VERSION,
          settingsStore: deps.settingsStore || 'settings',
          machineApi: secret !== '' ? 'secret-configured' : 'secret-not-configured',
        })
        return
      }

      if (method === 'GET' && sub2 === '/status') {
        const cat = await agents.catalog({ force: machine })
        const tasks = engine.list({ limit: 500 })
        const byStatus = {}
        for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1
        sendJson(res, 200, {
          ok: true,
          plugin: PLUGIN_ID,
          version: VERSION,
          agents: {
            total: cat.rows.length,
            live: cat.rows.filter((r) => r.live).length,
            running: cat.rows.filter((r) => r.running).length,
            degraded: cat.degraded || null,
            rows: cat.rows.slice(0, 60),
          },
          tasks: { byStatus, rows: tasks.slice(0, 40) },
          runners: c.runners.map((r) => ({ id: r.id, label: r.label, kind: r.kind, enabled: r.enabled !== false })),
          // never wait on a provider here: cached cards, background refresh
          providers: await providers.statusAll({ background: true }).catch(() => []),
          events: engine.store ? engine.store.tailEvents(40) : [],
        })
        return
      }

      if (method === 'GET' && sub2 === '/agents') {
        const cat = await agents.catalog({ force: url.searchParams.has('refresh') || machine })
        let rows = cat.rows
        const q = url.searchParams.get('q')
        if (q) {
          const needle = q.toLowerCase()
          rows = rows.filter((r) => (r.title || '').toLowerCase().includes(needle) || (r.sessionId || '').toLowerCase().includes(needle))
        }
        sendJson(res, 200, { ok: true, at: cat.at, rows })
        return
      }

      let m
      if (method === 'GET' && (m = sub2.match(/^\/agents\/([^/]+)$/))) {
        const ref = await agents.resolveRef(decodeURIComponent(m[1]))
        if (ref.kind === 'invalid' || ref.kind === 'unknown') { sendJson(res, 404, { ok: false, error: ref.reason || 'chat-not-found' }); return }
        if (ref.kind === 'ambiguous') { sendJson(res, 409, { ok: false, error: 'ambiguous-chat', candidates: ref.ids }); return }
        const st = await agents.status(ref.id)
        sendJson(res, 200, { ok: true, status: st })
        return
      }

      if (method === 'GET' && (m = sub2.match(/^\/agents\/([^/]+)\/transcript$/))) {
        const ref = await agents.resolveRef(decodeURIComponent(m[1]))
        if (ref.kind === 'invalid' || ref.kind === 'unknown') { sendJson(res, 404, { ok: false, error: ref.reason || 'chat-not-found' }); return }
        if (ref.kind === 'ambiguous') { sendJson(res, 409, { ok: false, error: 'ambiguous-chat', candidates: ref.ids }); return }
        const max = Number(url.searchParams.get('max')) || undefined
        const t = await agents.transcript(ref.id, { maxMessages: max })
        sendJson(res, 200, { ok: true, ...t })
        return
      }

      // ── mutations (browser gate or machine secret already passed) ─────
      if (method === 'POST' && sub2 === '/agents/spawn') {
        const r = await agents.spawn({
          title: body.title,
          prompt: body.prompt,
          preset: body.preset,
          cwd: body.cwd,
          count: body.count,
        })
        sendJson(res, r.ok ? 200 : 400, r)
        return
      }

      if (method === 'POST' && sub2 === '/agents/fork') {
        const ref = await agents.resolveRef(str(body.agent, LIMITS.idChars))
        if (ref.kind === 'invalid' || ref.kind === 'unknown') { sendJson(res, 404, { ok: false, error: ref.reason || 'chat-not-found' }); return }
        if (ref.kind === 'ambiguous') { sendJson(res, 409, { ok: false, error: 'ambiguous-chat', candidates: ref.ids }); return }
        const f = await agents.fork(ref.id, {
          title: typeof body.title === 'string' ? body.title : undefined,
          prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        })
        sendJson(res, f.ok ? 200 : 400, f)
        return
      }

      if (method === 'POST' && (m = sub2.match(/^\/agents\/([^/]+)\/prompt$/))) {
        const ref = await agents.resolveRef(decodeURIComponent(m[1]))
        if (ref.kind === 'invalid' || ref.kind === 'unknown') { sendJson(res, 404, { ok: false, error: ref.reason || 'chat-not-found' }); return }
        if (ref.kind === 'ambiguous') { sendJson(res, 409, { ok: false, error: 'ambiguous-chat', candidates: ref.ids }); return }
        const r = await agents.prompt({ sessionId: ref.id, text: body.message || body.text })
        sendJson(res, r.ok ? (r.via === 'controller' ? 202 : 200) : (r.notFound ? 404 : 400), { ...r, sessionId: ref.id })
        return
      }

      if (method === 'POST' && (m = sub2.match(/^\/agents\/([^/]+)\/cancel$/))) {
        const ref = await agents.resolveRef(decodeURIComponent(m[1]))
        if (ref.kind === 'invalid' || ref.kind === 'unknown') { sendJson(res, 404, { ok: false, error: ref.reason || 'chat-not-found' }); return }
        if (ref.kind === 'ambiguous') { sendJson(res, 409, { ok: false, error: 'ambiguous-chat', candidates: ref.ids }); return }
        const r = await agents.cancel(ref.id)
        sendJson(res, r.ok ? 200 : 400, { ...r, sessionId: ref.id })
        return
      }

      if (method === 'GET' && sub2 === '/tasks') {
        sendJson(res, 200, {
          ok: true,
          rows: engine.list({
            status: url.searchParams.get('status') || undefined,
            type: url.searchParams.get('type') || undefined,
            owner: url.searchParams.get('owner') || undefined,
            limit: Number(url.searchParams.get('limit')) || 200,
          }),
        })
        return
      }

      if (method === 'GET' && (m = sub2.match(/^\/tasks\/([^/]+)$/))) {
        const t = engine.get(decodeURIComponent(m[1]))
        if (!t) { sendJson(res, 404, { ok: false, error: 'no such task' }); return }
        sendJson(res, 200, { ok: true, task: t })
        return
      }

      if (method === 'GET' && (m = sub2.match(/^\/tasks\/([^/]+)\/output$/))) {
        const r = engine.output(decodeURIComponent(m[1]), { tail: Number(url.searchParams.get('tail')) || undefined })
        sendJson(res, r.ok ? 200 : 404, r)
        return
      }

      if (method === 'POST' && sub2 === '/tasks') {
        // ownerSession: the tab passes its own session id from the sidebar
        // scope so 'this chat' views can filter; callers may omit it.
        const r = await engine.create(body || {}, { ownerSession: body && body.ownerSession })
        if (r.ok) {
          sendJson(res, 200, { ok: true, task: engine.get(r.task.id) })
        } else {
          sendJson(res, 400, r)
        }
        return
      }

      if (method === 'POST' && (m = sub2.match(/^\/tasks\/([^/]+)\/cancel$/))) {
        const r = await engine.cancel(decodeURIComponent(m[1]), machine ? 'api' : 'browser')
        sendJson(res, r.ok ? 200 : (r.already ? 409 : 404), r)
        return
      }

      if (method === 'GET' && sub2 === '/runners') {
        const rows = []
        for (const r of c.runners) {
          rows.push({
            id: r.id, label: r.label, kind: r.kind, enabled: r.enabled !== false,
            probe: r.enabled === false ? null : await probeRunnerCached(r, { force: url.searchParams.has('probe') || machine }),
          })
        }
        sendJson(res, 200, { ok: true, rows, defaultRunner: c.tasks.defaultRunner })
        return
      }

      if (method === 'POST' && sub2 === '/runners/probe') {
        const id = str(body.runner, LIMITS.idChars)
        const runner = c.runners.find((r) => r.id === id)
        if (!runner) { sendJson(res, 404, { ok: false, error: 'unknown runner' }); return }
        sendJson(res, 200, { ok: true, probe: await probeRunnerCached(runner, { force: true }) })
        return
      }

      if (method === 'GET' && sub2 === '/providers') {
        sendJson(res, 200, { ok: true, rows: await providers.statusAll({ maxAgeMs: url.searchParams.has('refresh') ? 1 : undefined }) })
        return
      }

      if (method === 'GET' && sub2 === '/settings') {
        sendJson(res, 200, { ok: true, settings: safeSettings(c), envSecretPresent: Boolean((process.env[SECRET_ENV] || '').trim()) })
        return
      }

      if ((method === 'PUT' || method === 'POST') && sub2 === '/settings') {
        const patch = sanitizeSettingsPatch(body || {})
        if (Object.keys(patch).length === 0) { sendJson(res, 400, { ok: false, error: 'no-valid-settings-in-body' }); return }
        // Nested groups are merged with what is stored, so { tasks: { allowCommandTasks } }
        // changes that one field and keeps the others (lists such as runners replace).
        const current = effective()
        for (const [key, value] of Object.entries(patch)) {
          const was = current[key]
          if (value && typeof value === 'object' && !Array.isArray(value) && was && typeof was === 'object' && !Array.isArray(was)) {
            patch[key] = key === 'api' ? { ...was, ...value, secret: was.secret } : { ...was, ...value }
          }
        }
        const store = await persistSettingsPatch(patch)
        sendJson(res, 200, { ok: true, store, settings: safeSettings(effective()) })
        return
      }

      if (method === 'POST' && sub2 === '/secret') {
        if (body.clear === true) {
          await persistSettingsPatch({ api: { ...effective().api, secret: '' } })
          sendJson(res, 200, { ok: true, configured: false })
          return
        }
        const secret2 = typeof body.secret === 'string' ? body.secret.trim() : ''
        if (secret2.length < LIMITS.secretMin || secret2.length > LIMITS.secretMax) {
          sendJson(res, 400, { ok: false, error: 'secret must be ' + LIMITS.secretMin + '..' + LIMITS.secretMax + ' characters' })
          return
        }
        await persistSettingsPatch({ api: { ...effective().api, secret: secret2 } })
        sendJson(res, 200, { ok: true, configured: true, fingerprint: fingerprint(secret2) })
        return
      }

      if (method === 'GET' && sub2 === '/logs') {
        const n = Math.max(1, Math.min(200, Number(url.searchParams.get('n')) || 60))
        sendJson(res, 200, { ok: true, tail: engine.store ? engine.store.tailEvents(n) : [] })
        return
      }

      // ── machine-only: the tool-server contract + prompt inject ────────
      if (machine && method === 'POST' && sub2 === '/remote/run') {
        const kind = str(body.kind, 40)
        if (!kind) { sendJson(res, 400, { ok: false, error: 'kind is required' }); return }
        if (kind === 'probe') { sendJson(res, 200, { ok: true, status: 'completed', output: 'orchestrator tool server alive', detail: 'probe' }); return }
        if (kind === 'command') {
          const command = str(body.spec && body.spec.command, LIMITS.commandChars)
          if (!command.trim()) { sendJson(res, 400, { ok: false, error: 'spec.command is required' }); return }
          if (c.tasks.allowCommandTasks === false) { sendJson(res, 403, { ok: false, error: 'command tasks disabled on this host' }); return }
          const r = await engine.create({ type: 'command', command, runner: 'local', timeoutMs: Number(body.timeoutMs) || undefined, title: 'remote:' + command.slice(0, 40) })
          if (!r.ok) { sendJson(res, 400, r); return }
          const settled = await engine.waitSettledPublic(r.task.id)
          sendJson(res, 200, settled)
          return
        }
        if (kind === 'scrape' || kind === 'http') {
          const r = await engine.create({ type: kind, ...(body.spec || {}), timeoutMs: Number(body.timeoutMs) || undefined })
          if (!r.ok) { sendJson(res, 400, r); return }
          const settled = await engine.waitSettledPublic(r.task.id)
          sendJson(res, 200, settled)
          return
        }
        sendJson(res, 400, { ok: false, error: 'kind must be probe | command | scrape | http' })
        return
      }

      if (machine && method === 'POST' && sub2 === '/remote/prompt') {
        const chatRef = str(body.chat, LIMITS.idChars)
        const message = str(body.message, c.agents.promptMaxChars)
        if (!chatRef || !message.trim()) { sendJson(res, 400, { ok: false, error: 'chat and non-empty message are required' }); return }
        const ref = await agents.resolveRef(chatRef)
        if (ref.kind === 'invalid' || ref.kind === 'unknown') { sendJson(res, 404, { ok: false, error: 'chat-not-found', ref: chatRef.slice(0, 40) }); return }
        if (ref.kind === 'ambiguous') { sendJson(res, 409, { ok: false, error: 'ambiguous-chat', candidates: ref.ids }); return }
        const r = await agents.prompt({ sessionId: ref.id, text: message })
        sendJson(res, r.ok ? 202 : (r.notFound ? 404 : 409), { ok: r.ok, chat: ref.id, via: r.via || (r.ok ? 'controller' : undefined), error: r.ok ? undefined : r.error })
        return
      }

      if (machine && method === 'POST' && sub2 === '/remote/agents/create') {
        const r = await agents.spawn({
          title: body.title,
          prompt: body.prompt,
          preset: body.preset,
          cwd: body.cwd,
          count: body.count,
        })
        sendJson(res, r.ok ? 200 : 400, r)
        return
      }

      // Conductor: context, pins, inbox, versions, posts (lib/conductor/routes.js)
      if (deps.conductorRoute && (sub2.startsWith('/conductor/') || sub2 === '/remote/post')) {
        const handled = await deps.conductorRoute(sub2, method, { machine, body, url, req }, (code, value) => sendJson(res, code, value))
        if (handled) return
      }

      sendJson(res, 404, { ok: false, error: 'not-found', path: sub2 })
    }
  }
}

export const __api = { sendJson, readJsonBody }
