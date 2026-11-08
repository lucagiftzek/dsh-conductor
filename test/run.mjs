/**
 * dsh-conductor test suite (host half).
 *
 * Pure unit + integration tests against fakes - nothing mounts, nothing
 * touches a live DSH, nothing reaches the network (http fetch is injected).
 *
 * Run: node test/run.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fsP from 'node:fs/promises'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig, sanitizeSettingsPatch, sanitizeRunner, sanitizeProvider, safeSettings, LIMITS, DEFAULTS, str, clamp } from '../lib/core.js'
import { checkReadRequest, checkBrowserMutation, secretEquals, presentedSecret, makeRateLimiter, isLoopbackPeer, harnessCookieName } from '../lib/security.js'
import { TaskStore } from '../lib/store.js'
import { pickRunner, scrubbedEnv } from '../lib/runners.js'
import { TaskEngine, extractData, selectFirst, stripTags, composeOutput, publicTask, TERMINAL } from '../lib/tasks.js'
import { makeAgents, contentText } from '../lib/agents.js'
import { Providers } from '../lib/providers.js'
import { agentTools } from '../lib/tools.js'
import { makeHandler } from '../lib/api.js'

// ── helpers ─────────────────────────────────────────────────────────────────

let seq = 0
function fakeDefineTool() {
  return (def) => {
    assert(def.name, 'tool must have a name')
    assert(typeof def.description === 'string' && def.description.length > 20, 'tool needs a description')
    assert(def.parameters && typeof def.parameters === 'object')
    assert(typeof def.execute === 'function')
    assert(def.output && typeof def.output.render === 'function')
    // The REAL dsh-tools schema compiler rejects object params without an
    // explicit additionalProperties boolean (caught by the boot smoke on
    // 2026-09-23); enforce the same shape here so regressions fail in unit
    // tests, not at boot.
    for (const [key, schema] of Object.entries(def.parameters)) {
      if (schema && schema.type === 'object') {
        assert.ok(
          schema.additionalProperties === true || schema.additionalProperties === false,
          'object parameter ' + def.name + '.' + key + ' must declare additionalProperties: true|false',
        )
      }
    }
    return def
  }
}

function makeCfg(overrides = {}) {
  // Command tasks are opt-in since dsh-conductor; these engine tests run them.
  return resolveConfig({
    stateDir: overrides.stateDir || '/tmp/does-not-matter',
    ...overrides,
    tasks: { allowCommandTasks: true, ...(overrides.tasks || {}) },
  })
}

test('core: setupCompleted is empty on a fresh install and patchable', () => {
  assert.equal(resolveConfig({}).setupCompleted, '')
  assert.equal(sanitizeSettingsPatch({ setupCompleted: '2026-11-08T09:00:00Z' }).setupCompleted, '2026-11-08T09:00:00Z')
  assert.equal(resolveConfig({ setupCompleted: 42 }).setupCompleted, '')
})

test('core: shell command tasks and remote runners are off by default', () => {
  const c = resolveConfig({})
  assert.equal(c.tasks.allowCommandTasks, false)
  assert.equal(c.tasks.allowRemoteRunners, false)
  assert.equal(c.modelMay.clear, false)
  assert.equal(c.tools.legacy, false)
  assert.deepEqual(resolveConfig({ modelMay: { clear: true, bogus: true } }).modelMay.clear, true)
  assert.equal('bogus' in resolveConfig({ modelMay: { bogus: true } }).modelMay, false)
})

function fakeCtx({ agentsList = [], controller, query } = {}) {
  const agents = new Map(agentsList.map((a) => [a.id, a]))
  const ctx = {
    agents: {
      list: () => agentsList,
      get: (id) => agents.get(id),
    },
    get: (name) => {
      if (name === 'sessionController') return controller
      if (name === 'sessionQuery') return query
      return undefined
    },
  }
  return ctx
}

function fakeReq({ method = 'GET', url = '/', headers = { host: '127.0.0.1:3080' }, socket = { remoteAddress: '127.0.0.1' }, body } = {}) {
  const chunks = []
  if (body !== undefined) {
    chunks.push(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
  }
  return {
    method,
    url,
    headers,
    socket,
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c },
  }
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader: (k, v) => { res.headers[k.toLowerCase()] = v },
    writeHead: (code, hdrs) => { res.statusCode = code; Object.assign(res.headers, hdrs) },
    end: (text) => { res.body = String(text || '') },
  }
  res.json = () => JSON.parse(res.body || 'null')
  return res
}

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'orch-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

// ── core ────────────────────────────────────────────────────────────────────

test('core: defaults are inert (no hosts, no credentials, local runner only)', () => {
  assert.equal(DEFAULTS.runners.length, 1)
  assert.equal(DEFAULTS.runners[0].kind, 'local')
  assert.equal(DEFAULTS.providers.length, 0)
  assert.equal(DEFAULTS.api.secret, '')
})

test('core: resolveConfig sanitizes bad values', () => {
  const c = resolveConfig({
    tasks: { maxConcurrent: 99999, commandTimeoutMs: -5, scrapeMaxUrls: 1e9 },
    runners: [{ id: 'BAD ID!', kind: 'ssh' }, { id: 'ok-ssh', kind: 'ssh', ssh: { target: 'host' } }, { id: 'bad-http', kind: 'http', http: { url: 'ftp://nope' } }],
    providers: [{ id: 'hpc1', kind: 'hpc', url: 'http://127.0.0.1:3080/dsh-hpc/api/' }, { id: 'x', kind: 'nope', url: 'http://x' }],
  })
  assert.equal(c.tasks.maxConcurrent, LIMITS.concurrent[1])
  assert.equal(c.tasks.commandTimeoutMs, 500)
  assert.equal(c.tasks.scrapeMaxUrls, 64)
  // the built-in local runner always exists; operator entries merge on top
  assert.deepEqual(c.runners.map((r) => r.id), ['local', 'ok-ssh'])
  assert.equal(c.providers.length, 1)
  assert.equal(c.providers[0].url, 'http://127.0.0.1:3080/dsh-hpc/api')
})

test('core: sanitizeRunner builds ssh argv only from operator config', () => {
  const r = sanitizeRunner({ id: 'grey', kind: 'ssh', ssh: { target: 'build-box', extraArgs: ['-p', '2222'] } })
  assert.equal(r.ssh.target, 'build-box')
  assert.deepEqual(r.ssh.extraArgs, ['-p', '2222'])
  assert.equal(r.enabled, true)
})

test('core: sanitizeSettingsPatch drops unknown keys and never takes a secret', () => {
  const p = sanitizeSettingsPatch({ enabled: false, evil: 'x', api: { secret: 'should-not-land', rateLimitPerMinute: 99999 }, runners: [{ id: 'r', kind: 'local' }] })
  assert.equal(p.enabled, false)
  assert.equal(p.evil, undefined)
  assert.equal(p.api.secret, undefined)
  assert.equal(p.api.rateLimitPerMinute, 6000)
})

test('core: safeSettings masks the secret', () => {
  const c = makeCfg({ api: { secret: 'a-secret-value-1234' } })
  const s = safeSettings(c)
  assert.equal(s.api.secret, '')
  assert.equal(s.api.secretConfigured, true)
  assert.ok(s.api.secretFingerprint.length > 4)
})

// ── security ─────────────────────────────────────────────────────────────────

test('security: read gate refuses non-loopback peers and cross-site', () => {
  assert.equal(checkReadRequest(fakeReq(), {}).ok, true)
  const far = fakeReq({ socket: { remoteAddress: '8.8.8.8' } })
  assert.equal(checkReadRequest(far, {}).status, 403)
  const cross = fakeReq({ headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(checkReadRequest(cross, {}).status, 403)
})

test('security: read gate refuses POST', () => {
  const r = fakeReq({ method: 'POST' })
  const g = checkReadRequest(r, {})
  assert.equal(g.ok, false)
  assert.equal(g.status, 405)
})

test('security: browser mutation gate requires same-origin + CSRF header + cookie', () => {
  const cookieName = harnessCookieName('127.0.0.1:3080')
  const base = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'dsh-conductor',
      'sec-fetch-site': 'same-origin',
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      cookie: cookieName + '=session-value',
    },
  }
  assert.equal(checkBrowserMutation(fakeReq(base), { pluginId: 'dsh-conductor' }).ok, true)
  const noCsurf = fakeReq({ ...base, headers: { ...base.headers, 'x-requested-with': 'other' } })
  assert.equal(checkBrowserMutation(noCsurf, { pluginId: 'dsh-conductor' }).layer, 'R3')
  const noCookie = fakeReq({ ...base, headers: { ...base.headers, cookie: '' } })
  assert.equal(checkBrowserMutation(noCookie, { pluginId: 'dsh-conductor' }).layer, 'R4')
  const form = fakeReq({ ...base, headers: { ...base.headers, 'content-type': 'application/x-www-form-urlencoded' } })
  assert.equal(checkBrowserMutation(form, { pluginId: 'dsh-conductor' }).status, 415)
  const noOrigin = fakeReq({ ...base, headers: { ...base.headers } })
  delete noOrigin.headers.origin
  assert.equal(checkBrowserMutation(noOrigin, { pluginId: 'dsh-conductor' }).layer, 'R3')
})

test('security: secretEquals is constant-time-ish and rejects empties', () => {
  assert.equal(secretEquals('abc', 'abc'), true)
  assert.equal(secretEquals('abc', 'abd'), false)
  assert.equal(secretEquals('', 'abc'), false)
  assert.equal(secretEquals('abc', ''), false)
})

test('security: presentedSecret reads both header forms', () => {
  assert.equal(presentedSecret({ 'x-conductor-secret': 'tok' }, 'x-conductor-secret'), 'tok')
  assert.equal(presentedSecret({ authorization: 'Bearer tok2' }, 'x-conductor-secret'), 'tok2')
  assert.equal(presentedSecret({}, 'x-conductor-secret'), '')
})

test('security: rate limiter throttles within a minute', () => {
  let t = 0
  const rl = makeRateLimiter(() => 2, () => t)
  assert.equal(rl.take('ip').ok, true)
  assert.equal(rl.take('ip').ok, true)
  assert.equal(rl.take('ip').ok, false)
  t = 61_000
  assert.equal(rl.take('ip').ok, true)
})

// ── store ────────────────────────────────────────────────────────────────────

test('store: tasks persist and reload atomically', async () => {
  await withTmp(async (dir) => {
    const s = new TaskStore(dir)
    await s.init()
    s.upsert({ id: 't1', status: 'running', type: 'command', title: 'x' })
    await s.flush()
    const s2 = new TaskStore(dir)
    await s2.init()
    assert.equal(s2.get('t1').status, 'running')
  })
})

test('store: torn files start empty, events are bounded', async () => {
  await withTmp(async (dir) => {
    await fsP.mkdir(dir, { recursive: true })
    await fsP.writeFile(join(dir, 'tasks.json'), '{not json')
    const s = new TaskStore(dir)
    await s.init()
    assert.deepEqual(s.list(), [])
    for (let i = 0; i < 20; i++) await s.appendEvent({ event: 'e' + i })
    assert.equal(s.tailEvents(5).length, 5)
  })
})

// ── runners ──────────────────────────────────────────────────────────────────

test('runners: pickRunner honours explicit id, default, and disabled', () => {
  const runners = [
    { id: 'local', kind: 'local', enabled: true },
    { id: 'grey', kind: 'ssh', enabled: true },
    { id: 'off', kind: 'ssh', enabled: false },
  ]
  assert.equal(pickRunner(runners, 'grey').runner.id, 'grey')
  assert.equal(pickRunner(runners, 'auto').runner.id, 'local')
  assert.equal(pickRunner(runners, 'off').error, 'runner is disabled: off')
  assert.equal(pickRunner(runners, 'nope').error, 'unknown runner: nope')
  const onlyRemote = [{ id: 'grey', kind: 'ssh', enabled: true }]
  assert.equal(pickRunner(onlyRemote, 'auto', { defaultRunner: 'missing' }).runner.id, 'grey')
})

test('runners: local command actually executes and captures output', async () => {
  const r = await import('../lib/runners.js')
  const out = await r.runOnRunner({ id: 'local', kind: 'local' }, 'echo hello-orch', { timeoutMs: 5000 })
  assert.equal(out.ok, true)
  assert.ok(out.stdout.includes('hello-orch'))
})

test('runners: onChunk streams output as it arrives', async () => {
  const r = await import('../lib/runners.js')
  const chunks = []
  const out = await r.runOnRunner(
    { id: 'local', kind: 'local' },
    'echo phase-one; sleep 0.4; echo phase-two',
    { timeoutMs: 10000, onChunk: (text, stream) => chunks.push({ text: String(text).trim(), stream }) },
  )
  assert.equal(out.ok, true)
  const texts = chunks.map((c) => c.text).filter(Boolean)
  assert.ok(texts.includes('phase-one'), 'first phase streamed: ' + JSON.stringify(texts))
  assert.ok(texts.includes('phase-two'), 'second phase streamed: ' + JSON.stringify(texts))
  assert.ok(chunks.every((c) => c.stream === 'stdout'))
})

test('tasks: live output lands in the task record while a command runs', async () => {
  await withTmp(async (dir) => {
    const cfg = makeCfg({ stateDir: dir, tasks: { maxConcurrent: 2, commandTimeoutMs: 15000 } })
    const store = new TaskStore(dir)
    const engine = new TaskEngine(cfg, store, fakeAgentsFacade())
    await engine.boot()
    const created = await engine.create({ type: 'command', command: 'echo live-part-one; sleep 1; echo live-part-two', runner: 'local' })
    assert.equal(created.ok, true)
    // midpoint: output must already contain the first phase while running
    await new Promise((res) => setTimeout(res, 400))
    const mid = engine.output(created.task.id)
    assert.equal(mid.status, 'running', 'task is still running at midpoint')
    assert.ok(mid.output.includes('live-part-one'), 'live output visible before completion: ' + JSON.stringify(mid.output))
    const settled = await engine.waitSettled(created.task.id)
    assert.equal(settled.status, 'completed')
    const fin = engine.output(created.task.id)
    assert.ok(fin.output.includes('live-part-one'))
    assert.ok(fin.output.includes('live-part-two'))
  })
})

test('tasks: scrape reports per-URL progress through onUrl', async () => {
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    await new Promise((res) => setTimeout(res, 60))
    return { ok: true, status: 200, text: async () => '<p>ok ' + calls + '</p>' }
  }
  try {
    const cfg = makeCfg({ stateDir: '/tmp/na' })
    const store = { list: () => [], get: () => null, upsert: () => {}, appendEvent: async () => {}, dirty: false, flush: async () => {} }
    const engine = new TaskEngine(cfg, store, fakeAgentsFacade())
    const lines = []
    await engine.scrapeOnce({ urls: ['http://a/1', 'http://a/2'], extract: 'text', timeoutMs: 5000 }, { onUrl: (l) => lines.push(String(l)) })
    assert.equal(lines.length, 4, 'two lines per url (start + result): ' + JSON.stringify(lines))
    assert.ok(lines[0].includes('1/2'), 'first progress line is numbered')
    assert.ok(lines[1].includes('200'), 'result line carries the status')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('runners: failing commands report non-zero exit', async () => {
  const r = await import('../lib/runners.js')
  const out = await r.runOnRunner({ id: 'local', kind: 'local' }, 'exit 3', { timeoutMs: 5000 })
  assert.equal(out.ok, false)
  assert.equal(out.code, 3)
})

test('runners: scrubbedEnv carries no secrets', () => {
  const env = scrubbedEnv()
  assert.equal(env.SSH_AUTH_SOCK, undefined)
  assert.equal(env.PATH.includes('/usr/bin'), true)
})

// ── tasks: extraction helpers ────────────────────────────────────────────────

test('tasks: stripTags removes scripts and styles', () => {
  const t = stripTags('<html><head><style>.x{}</style><script>bad()</script></head><body><p>Hello &amp; welcome</p></body></html>')
  assert.ok(t.includes('Hello & welcome'))
  assert.ok(!t.includes('bad()'))
})

test('tasks: selectFirst matches tag/class/id/attr', () => {
  const html = '<div><h1 class="title" id="t">One</h1><h1>Two</h1></div>'
  assert.ok(String(selectFirst(html, 'h1')).includes('One'))
  assert.ok(String(selectFirst(html, 'h1.title')).includes('One'))
  assert.ok(String(selectFirst(html, '#t')).includes('One'))
  assert.equal(selectFirst(html, 'h1', 'class'), 'title')
  assert.equal(selectFirst(html, 'h2'), null)
})

test('tasks: extractData regex returns all matches', () => {
  const out = extractData('price: 10 EUR and 20 EUR', { pattern: '(\\d+) EUR' })
  assert.deepEqual(out, [['10'], ['20']])
})

test('tasks: composeOutput truncates at cap', () => {
  const out = composeOutput({ stdout: 'x'.repeat(100), stderr: '' }, 10)
  assert.ok(out.startsWith('xxxxxxxxxx'))
  assert.ok(out.includes('truncated'))
})

// ── tasks: engine lifecycle with a fake runner ───────────────────────────────

async function makeEngine(dir, { runnerFn, agentsFacade } = {}) {
  const cfg = makeCfg({ stateDir: dir, tasks: { maxConcurrent: 1, commandTimeoutMs: 2000, pollMs: 50 } })
  const store = new TaskStore(dir)
  const agents = agentsFacade || fakeAgentsFacade()
  const engine = new TaskEngine(cfg, store, agents, { now: () => Date.now() })
  if (runnerFn) {
    engine.runners = () => [{ id: 'fake', kind: 'local', enabled: true }]
    const orig = engine.runWorkTask.bind(engine)
    // route all work through the fake runner
    engine.runWorkTask = async (task) => {
      const r = await runnerFn(task)
      task.output = composeOutput(r, 4096)
      task.result = { status: r.ok ? 'completed' : 'failed', detail: r.detail || '', via: 'fake' }
      task.detail = task.result.detail
      engine.settle(task, r.ok ? 'completed' : 'failed')
    }
  }
  await engine.boot()
  return { engine, store, agents, cfg }
}

function fakeAgentsFacade(overrides = {}) {
  return {
    catalog: async () => ({ at: Date.now(), rows: [], known: new Set(), titles: new Map() }),
    resolveRef: async (ref) => overrides.resolveRef ? overrides.resolveRef(ref) : { kind: 'unknown', reason: 'none' },
    spawn: async (o) => overrides.spawn ? overrides.spawn(o) : { ok: false, error: 'no controller' },
    fork: async (id) => ({ ok: false, error: 'no controller' }),
    prompt: async (o) => overrides.prompt ? overrides.prompt(o) : { ok: false, error: 'no agent' },
    cancel: async (id) => ({ ok: true }),
    status: async (id) => overrides.status ? overrides.status(id) : { sessionId: id, live: false, running: false, status: 'cold', title: '', lastAssistant: '', lastUser: '' },
    transcript: async (id) => ({ sessionId: id, messages: [] }),
    ...overrides,
  }
}

test('tasks: command task completes and persists', async () => {
  await withTmp(async (dir) => {
    const { engine } = await makeEngine(dir, {
      runnerFn: async () => ({ ok: true, stdout: 'all good', stderr: '', detail: 'exit code: 0' }),
    })
    const r = await engine.create({ type: 'command', command: 'echo hi', runner: 'auto' })
    assert.equal(r.ok, true)
    await engine.waitSettled(r.task.id)
    const t = engine.get(r.task.id)
    assert.equal(t.status, 'completed')
    const out = engine.output(r.task.id)
    assert.ok(out.output.includes('all good'))
    assert.ok(t.outputPreview.includes('all good'))
  })
})

test('tasks: failing command settles failed with detail', async () => {
  await withTmp(async (dir) => {
    const { engine } = await makeEngine(dir, {
      runnerFn: async () => ({ ok: false, stdout: '', stderr: 'boom', detail: 'exit code: 2' }),
    })
    const r = await engine.create({ type: 'command', command: 'false' })
    await engine.waitSettled(r.task.id)
    const t = engine.get(r.task.id)
    assert.equal(t.status, 'failed')
    assert.equal(t.result.detail, 'exit code: 2')
  })
})

test('tasks: validation failures leave no trace', async () => {
  await withTmp(async (dir) => {
    const { engine, store } = await makeEngine(dir)
    const bad = await engine.create({ type: 'command', command: '' })
    assert.equal(bad.ok, false)
    const bad2 = await engine.create({ type: 'nope' })
    assert.equal(bad2.ok, false)
    assert.equal(store.list().length, 0)
  })
})

test('tasks: cancel kills the REAL process group - no orphans', async () => {
  // Regression for the live-caught bug: nothing registered the command's kill
  // handle, so cancel only flipped the record while the process kept running.
  // 'sleep & wait' makes sleep a separate child of bash - the orphan case.
  await withTmp(async (dir) => {
    const cfg = makeCfg({ stateDir: dir, tasks: { maxConcurrent: 2, commandTimeoutMs: 60000 } })
    const store = new TaskStore(dir)
    const engine = new TaskEngine(cfg, store, fakeAgentsFacade())
    await engine.boot()
    const pidFile = join(dir, 'sleep.pid')
    const r = await engine.create({ type: 'command', runner: 'local', command: 'sleep 30 & echo ' + '$!' + ' > ' + pidFile + '; wait' })
    assert.equal(r.ok, true)
    let pid = 0
    for (let i = 0; i < 40 && !pid; i++) {
      await new Promise((res) => setTimeout(res, 50))
      try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()) } catch { /* not yet */ }
    }
    assert.ok(pid > 0, 'grandchild sleep started')
    const c = await engine.cancel(r.task.id, 'test')
    assert.equal(c.ok, true)
    let alive = true
    for (let i = 0; i < 40 && alive; i++) {
      await new Promise((res) => setTimeout(res, 50))
      try { process.kill(pid, 0) } catch { alive = false }
    }
    assert.equal(alive, false, 'the sleep grandchild was killed with its group')
    const t = engine.get(r.task.id)
    assert.equal(t.status, 'cancelled')
    assert.ok(String(t.detail).startsWith('cancelled'), 'late runner result did not overwrite the cancel: ' + t.detail)
  })
})

test('tasks: jobs-mirror cancel does not recurse', async () => {
  await withTmp(async (dir) => {
    const cfg = makeCfg({ stateDir: dir, mirrorJobs: true, tasks: { maxConcurrent: 2, commandTimeoutMs: 60000 } })
    const store = new TaskStore(dir)
    const engine = new TaskEngine(cfg, store, fakeAgentsFacade())
    let handle = null
    engine.setJobsLookup(() => ({ start: (spec) => { handle = spec.run(); return 'job-1' } }))
    await engine.boot()
    let inner = 0
    const origInner = engine.cancelInner.bind(engine)
    engine.cancelInner = async (...a) => { inner += 1; return origInner(...a) }
    const r = await engine.create({ type: 'command', runner: 'local', command: 'sleep 20' })
    await new Promise((res) => setTimeout(res, 150))
    assert.ok(handle, 'the task was mirrored into the jobs surface')
    // cancel from the Background Tasks side, as a user would
    handle.cancel()
    await new Promise((res) => setTimeout(res, 100))
    assert.equal(engine.get(r.task.id).status, 'cancelled')
    assert.equal(inner, 1, 'exactly one cancellation pass (no recursion)')
  })
})

test('tasks: restart reaps running tasks as interrupted', async () => {
  await withTmp(async (dir) => {
    const store = new TaskStore(dir)
    await store.init()
    store.upsert({ id: 'stuck', status: 'running', type: 'command', title: 'x' })
    await store.flush()
    const { engine } = await makeEngine(dir)
    assert.equal(engine.get('stuck').status, 'interrupted')
  })
})

test('tasks: concurrency cap queues extra tasks', async () => {
  await withTmp(async (dir) => {
    let running = 0
    let peak = 0
    const { engine } = await makeEngine(dir, {
      runnerFn: async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise((res) => setTimeout(res, 60))
        running -= 1
        return { ok: true, stdout: 'done', stderr: '' }
      },
    })
    const ids = []
    for (let i = 0; i < 3; i++) {
      const r = await engine.create({ type: 'command', command: 'job' + i })
      ids.push(r.task.id)
    }
    await engine.waitSettled(ids[2])
    assert.ok(peak <= 1, 'concurrency cap violated: peak=' + peak)
    for (const id of ids) assert.equal(engine.get(id).status, 'completed')
  })
})

test('tasks: agent task spawns, polls, settles completed on answer', async () => {
  await withTmp(async (dir) => {
    let polled = 0
    const agentsFacade = fakeAgentsFacade({
      spawn: async () => ({ ok: true, created: [{ sessionId: 'session-xyz' }], prompted: 1, failures: [] }),
      status: async (id) => {
        polled += 1
        // first poll: still working; later: idle with an answer
        const working = polled <= 1
        return { sessionId: id, live: true, running: working, status: working ? 'running' : 'live', title: 'T', lastAssistant: working ? '' : 'the answer is 42', lastAssistantAt: working ? 0 : Date.now(), lastUser: 'q' }
      },
    })
    const cfg = makeCfg({ stateDir: dir, tasks: { pollMs: 30 } })
    const store = new TaskStore(dir)
    const engine = new TaskEngine(cfg, store, agentsFacade)
    await engine.boot()
    const r = await engine.create({ type: 'agent', prompt: 'answer me' })
    assert.equal(r.ok, true)
    const settled = await engine.waitSettled(r.task.id, { })
    assert.equal(settled.status, 'completed')
    const t = engine.get(r.task.id)
    assert.equal(t.agentSessionId, 'session-xyz')
    const out = engine.output(r.task.id)
    assert.ok(out.output.includes('42'))
    assert.ok(t.outputPreview.includes('42'))
  })
})

test('providers: background mode never waits on a slow provider and dedupes refreshes', async () => {
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (url) => {
    calls += 1
    await new Promise((r) => setTimeout(r, 120))
    const body = String(url).includes('/health') ? { ok: true } : { headline: 'H', staged: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  try {
    const cfg = { providers: [{ id: 'hpc', kind: 'hpc', label: 'HPC', url: 'http://x/api', enabled: true, pollSeconds: 60 }] }
    const pv = new Providers(cfg)
    const t0 = Date.now()
    const first = await pv.statusAll({ background: true })
    assert.ok(Date.now() - t0 < 50, 'background read did not wait on the provider')
    assert.equal(first[0].pending, true)
    await pv.statusAll({ background: true }) // second poll while in flight: no new fetches
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(calls, 2, 'one refresh (health + state), deduped: ' + calls)
    const later = await pv.statusAll({ background: true })
    assert.equal(later[0].ok, true)
    assert.equal(later[0].headline, 'H')
    // explicit reads are parallel + awaited and honour a forced refresh
    const forced = await pv.statusAll({ maxAgeMs: 1 })
    assert.equal(forced[0].ok, true)
  } finally {
    globalThis.fetch = origFetch
  }
})

test('tasks: agent task fails fast when the model turn errors', async () => {
  // Live-caught: an errored turn left the task 'running' for 5 minutes and
  // then reported 'completed'. It must fail at once, carrying the error.
  await withTmp(async (dir) => {
    const agentsFacade = fakeAgentsFacade({
      spawn: async () => ({ ok: true, created: [{ sessionId: 'session-err' }], prompted: 1, failures: [] }),
      status: async (id) => ({ sessionId: id, live: true, running: false, status: 'idle', title: '', lastAssistant: '', lastAssistantAt: 0, lastUser: 'q',
        lastTurnEnd: { seq: 9, time: Date.now(), kind: 'error', error: 'no adapter registered for anthropic' } }),
    })
    const cfg = makeCfg({ stateDir: dir, tasks: { pollMs: 30 } })
    const engine = new TaskEngine(cfg, new TaskStore(dir), agentsFacade)
    await engine.boot()
    const r = await engine.create({ type: 'agent', prompt: 'answer me' })
    const settled = await engine.waitSettled(r.task.id)
    assert.equal(settled.status, 'failed')
    assert.ok(engine.get(r.task.id).detail.includes('no adapter registered'), engine.get(r.task.id).detail)
  })
})

test('tasks: agent task ignores a stale answer from before it started', async () => {
  await withTmp(async (dir) => {
    let polled = 0
    const old = Date.now() - 60000
    const agentsFacade = fakeAgentsFacade({
      resolveRef: async () => ({ kind: 'exact', id: 'session-old' }),
      prompt: async () => ({ ok: true, via: 'followup' }),
      status: async (id) => {
        polled += 1
        const fresh = polled >= 3
        return { sessionId: id, live: true, running: false, status: 'idle', title: '', lastUser: 'q',
          lastAssistant: fresh ? 'fresh answer' : 'OLD answer', lastAssistantAt: fresh ? Date.now() : old }
      },
    })
    const cfg = makeCfg({ stateDir: dir, tasks: { pollMs: 30 } })
    const engine = new TaskEngine(cfg, new TaskStore(dir), agentsFacade)
    await engine.boot()
    const r = await engine.create({ type: 'agent', prompt: 'new question', promptExisting: 'session-old' })
    const settled = await engine.waitSettled(r.task.id)
    assert.equal(settled.status, 'completed')
    const out = engine.output(r.task.id).output
    assert.ok(out.includes('fresh answer') && !out.includes('OLD'), out)
    assert.ok(polled >= 3, 'did not settle on the stale answer')
  })
})

test('tasks: agent task failure surfaces the spawn error', async () => {
  await withTmp(async (dir) => {
    const agentsFacade = fakeAgentsFacade({
      spawn: async () => ({ ok: false, created: [], prompted: 0, failures: ['no controller'] }),
    })
    const cfg = makeCfg({ stateDir: dir })
    const store = new TaskStore(dir)
    const engine = new TaskEngine(cfg, store, agentsFacade)
    await engine.boot()
    const r = await engine.create({ type: 'agent', prompt: 'x' })
    const settled = await engine.waitSettled(r.task.id)
    assert.equal(settled.status, 'failed')
  })
})

test('tasks: ownerSession stamps and filters - this-chat scoping', async () => {
  await withTmp(async (dir) => {
    const cfg = makeCfg({ stateDir: dir })
    const store = new TaskStore(dir)
    const engine = new TaskEngine(cfg, store, fakeAgentsFacade())
    await engine.boot()
    const mine = await engine.create({ type: 'command', command: 'echo mine' }, { ownerSession: 'session-mine-1234' })
    await engine.create({ type: 'command', command: 'echo other' }, { ownerSession: 'session-other-99' })
    await engine.create({ type: 'command', command: 'echo tool' })
    assert.equal(mine.task.ownerSession, 'session-mine-1234')
    const onlyMine = engine.list({ owner: 'session-mine-1234' })
    assert.equal(onlyMine.length, 1)
    assert.equal(onlyMine[0].id, mine.task.id)
    // agent tasks driving an owner session also match the owner filter
    store.upsert({ id: 'ag-1', type: 'agent', status: 'completed', title: 'x', ownerSession: null, agentSessionId: 'session-mine-1234' })
    const withAgent = engine.list({ owner: 'session-mine-1234' })
    assert.equal(withAgent.length, 2)
    assert.equal(engine.list({}).length, 4)
  })
})

test('agents: catalog degrades to live agents when the controller seam hangs', async () => {
  const never = new Promise(() => {})
  const controller = {
    create: async () => ({ sessionId: 'z' }),
    list: () => never, // hangs forever - the production failure mode
    prompt: async () => ({ accepted: true }),
    cancel: async () => ({ accepted: true }),
  }
  const ctx = fakeCtx({
    agentsList: [{ id: 'live-1', status: 'idle', session: { header: { id: 'live-1' } } }],
    controller,
  })
  const agents = makeAgents(ctx, makeCfg({ agents: { catalogTtlMs: 50, listBudgetMs: 300 } }))
  // The budget timer is unref'd (it must never hold a server process open), so
  // keep this test's event loop alive while it waits, or a quiet runner ends it.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const cat = await agents.catalog({ force: true })
    assert.ok(cat.rows.some((r) => r.sessionId === 'live-1'), 'live agent row survives the controller hang')
    assert.ok(Array.isArray(cat.degraded) && cat.degraded.length >= 1, 'degraded reason recorded: ' + JSON.stringify(cat.degraded))
  } finally {
    clearInterval(keepAlive)
  }
})

// ── agents facade ────────────────────────────────────────────────────────────

test('agents: catalog merges controller list and live agents', async () => {
  // This fake mirrors the REAL controller contract, which the sandbox run
  // exposed: list/page REQUIRE an AbortSignal (they call throwIfAborted),
  // page rejects throughSeq past the session cursor with 'past cursor N', and
  // page records are wrapped as { type: 'event', event }.
  const needSignal = (signal) => { signal.throwIfAborted() }
  const log = [
    { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'hello' }] } } },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'error', error: { message: 'no adapter registered for provider "x"' } } } },
  ]
  const controller = {
    create: async () => ({ sessionId: 'new-1' }),
    list: async (_req, signal) => { needSignal(signal); return { items: [{ sessionId: 's1', updatedAt: 100, running: false, blank: false, cwd: '/x' }] } },
    prompt: async (_req, signal) => { needSignal(signal); return { accepted: true } },
    cancel: async () => ({ accepted: true }),
    page: async (req, signal) => {
      needSignal(signal)
      const cursor = log.at(-1).seq
      if (req.throughSeq > cursor) throw new Error('session page through seq ' + req.throughSeq + ' is past cursor ' + cursor)
      return { records: log.filter((e) => e.seq <= req.throughSeq).map((event) => ({ type: 'event', event })), hasMore: false }
    },
  }
  const ctx = fakeCtx({ agentsList: [{ id: 'live-2', status: 'idle', session: { header: { id: 'live-2' } } }], controller })
  const agents = makeAgents(ctx, makeCfg())
  const cat = await agents.catalog({ force: true })
  const ids = cat.rows.map((r) => r.sessionId)
  assert.ok(ids.includes('s1'))
  assert.ok(ids.includes('live-2'))
  const tr = await agents.transcript('s1')
  assert.equal(tr.error, undefined, 'transcript error: ' + tr.error)
  assert.equal(tr.messages.length, 2)
  assert.equal(tr.messages[0].role, 'user')
  assert.equal(tr.messages[1].text, 'hello', 'reasoning blocks are not shown as text')
  assert.equal(tr.lastTurnEnd.kind, 'error')
  assert.ok(tr.lastTurnEnd.error.includes('no adapter'))
  const st = await agents.status('s1')
  assert.equal(st.lastAssistant, 'hello')
  assert.equal(st.lastAssistantAt, 2)
  assert.equal(st.lastTurnEnd.kind, 'error')
})

test('agents: spawn with a first prompt delivers it (shadowing regression)', async () => {
  // Regression for the live-caught bug: spawn parameter `prompt` shadowed
  // the internal prompt() helper -> prompt is not a function.
  let delivered = null
  const controller = {
    create: async (req) => ({ sessionId: 'session-spawn-x', agentPreset: 'standard' }),
    list: async () => ({ items: [] }),
    prompt: async (r) => { delivered = r; return { accepted: true } },
    cancel: async () => ({ accepted: true }),
    rename: async () => ({ title: 't', seq: 1 }),
  }
  const ctx = fakeCtx({ controller })
  const agents = makeAgents(ctx, makeCfg())
  const s = await agents.spawn({ title: 'T', prompt: 'hello spawned agent', count: 1 })
  assert.equal(s.ok, true)
  assert.equal(s.created.length, 1)
  assert.equal(s.prompted, 1, 'the first prompt was delivered')
  assert.ok(delivered && delivered.content[0].text === 'hello spawned agent')
})

test('agents: prompt prefers live followup, falls back to controller', async () => {
  let followed = null
  const controller = {
    create: async () => ({ sessionId: 'z' }),
    list: async () => ({ items: [] }),
    prompt: async (req) => { controller.prompted = req; return { accepted: true } },
  }
  const ctx = fakeCtx({
    agentsList: [{ id: 'live-1', status: 'idle', session: {} }],
    controller,
  })
  ctx.agents.get = (id) => id === 'live-1' ? { id, status: 'idle', followup: (m) => { followed = m } } : undefined
  const agents = makeAgents(ctx, makeCfg())
  const r = await agents.prompt({ sessionId: 'live-1', text: 'hello' })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'followup')
  assert.equal(followed.content[0].text, 'hello')
  const r2 = await agents.prompt({ sessionId: 'cold-9', text: 'wake' })
  assert.equal(r2.ok, true)
  assert.equal(r2.via, 'controller')
})

test('agents: contentText tolerates junk', () => {
  assert.equal(contentText(null), '')
  assert.equal(contentText([{ type: 'image' }]), '')
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a' + String.fromCharCode(10) + 'b')
})

test('agents + providers: a config getter keeps reads live (settings changes apply)', async () => {
  // Regression: the facades captured a resolved config object at construction,
  // so settings edits never reached them. They now accept a getter.
  const promptText = 'x'.repeat(300)
  let mutable = makeCfg({ agents: { promptMaxChars: 50 } })
  const agents = makeAgents(fakeCtx({ agentsList: [{ id: 'live-1', status: 'idle', session: {} }] }), () => mutable)
  const r1 = await agents.prompt({ sessionId: 'live-1', text: promptText })
  const delivered1 = r1.delivered || 0
  // now widen the limit and confirm the facade observes it (the message
  // length check reads the live config)
  mutable = makeCfg({ agents: { promptMaxChars: 50 }, providers: [{ id: 'p', label: 'P', kind: 'http', url: 'http://127.0.0.1:9/x', enabled: true, pollSeconds: 60 }] })
  const providers = new Providers(() => mutable)
  assert.equal(providers.list().length, 1)
  mutable = makeCfg({ providers: [] })
  assert.equal(providers.list().length, 0, 'providers must observe the config change')
})

// ── providers ────────────────────────────────────────────────────────────────

test('providers: hpc adapter reads health + state', async () => {
  const calls = []
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).endsWith('/health')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, plugin: 'dsh-hpc', version: '0.2.0' }) }
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        headline: 'grant ok', balance: { gpu_hours_left: 4000 }, collector: { status: 'ok', checked_at: 1 },
        queue: { running: [], pending: [] }, staged: [{ arm: { armed: true } }, { arm: { armed: false } }],
      }),
    }
  }
  try {
    const cfg = makeCfg({ providers: [{ id: 'hpc', label: 'HPC', kind: 'hpc', url: 'http://127.0.0.1:3080/dsh-hpc/api', enabled: true, pollSeconds: 60 }] })
    const p = new Providers(cfg)
    const s = await p.status(cfg.providers[0])
    assert.equal(s.ok, true)
    assert.equal(s.headline, 'grant ok')
    assert.equal(s.staged, 2)
    assert.equal(s.armed, 1)
    assert.ok(calls.some((c) => c.includes('/health')))
    assert.ok(calls.some((c) => c.includes('/state')))
  } finally {
    globalThis.fetch = origFetch
  }
})

test('providers: unreachable provider degrades to a down card', async () => {
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
  try {
    const cfg = makeCfg({ providers: [{ id: 'p', label: 'P', kind: 'http', url: 'http://127.0.0.1:9/x', enabled: true, pollSeconds: 60 }] })
    const p = new Providers(cfg)
    const s = await p.status(cfg.providers[0])
    assert.equal(s.ok, false)
    assert.ok(s.detail.includes('unreachable'))
  } finally {
    globalThis.fetch = origFetch
  }
})

// ── tools ────────────────────────────────────────────────────────────────────

test('tools: all 14 definitions compile against a fake defineTool', () => {
  const cfg = makeCfg()
  const agents = fakeAgentsFacade()
  const store = { list: () => [], get: () => null, upsert: () => {}, tailEvents: () => [] }
  const engine = new TaskEngine(cfg, store, agents)
  const providers = new Providers(cfg)
  const defs = agentTools(fakeDefineTool(), { engine, agents, providers, cfg, probeRunners: async () => ({ ok: true, ms: 1 }) })
  assert.equal(defs.length, 14)
  assert.deepEqual(defs.map((d) => d.name).sort(), [
    'orch_agent_cancel', 'orch_agent_fork', 'orch_agent_prompt', 'orch_agent_spawn', 'orch_agent_status',
    'orch_agents_list', 'orch_providers', 'orch_runners', 'orch_status', 'orch_task_cancel', 'orch_task_create',
    'orch_task_list', 'orch_task_output', 'orch_task_status',
  ].sort())
})

test('tools: orch_task_create executes against the engine', async () => {
  await withTmp(async (dir) => {
    const { engine, agents } = await makeEngine(dir, {
      runnerFn: async () => ({ ok: true, stdout: 'line1', stderr: '' }),
    })
    const providers = new Providers(makeCfg())
    const defs = agentTools(fakeDefineTool(), { engine, agents, providers, cfg: makeCfg(), probeRunners: async () => ({ ok: true }) })
    const create = defs.find((d) => d.name === 'orch_task_create')
    const r = await create.execute({ type: 'command', command: 'echo hi', title: 't1' })
    assert.equal(r.ok, true)
    await engine.waitSettled(r.task.id)
    const output = defs.find((d) => d.name === 'orch_task_output')
    const o = await output.execute({ taskId: r.task.id })
    assert.ok(o.output.includes('line1'))
    const listTool = defs.find((d) => d.name === 'orch_task_list')
    const l = await listTool.execute({})
    assert.ok(l.rows.length >= 1)
  })
})

test('tools: render functions produce text', async () => {
  const cfg = makeCfg()
  const agents = fakeAgentsFacade()
  const engine = new TaskEngine(cfg, { list: () => [], get: () => null, upsert: () => {} }, agents)
  const providers = new Providers(cfg)
  const defs = agentTools(fakeDefineTool(), { engine, agents, providers, cfg, probeRunners: async () => ({ ok: true }) })
  for (const d of defs) {
    const v = await d.execute({ agent: 'x', taskId: 'x' })
    const blocks = d.output.render({}, v)
    assert.ok(Array.isArray(blocks) && typeof blocks[0].text === 'string')
  }
})

// ── api: gates ───────────────────────────────────────────────────────────────

async function makeApi(dir, { secret = '' } = {}) {
  const cfg = makeCfg({ stateDir: dir, api: { secret } })
  const store = new TaskStore(dir)
  const agents = fakeAgentsFacade({
    resolveRef: async (ref) => ({ kind: 'exact', id: 'session-' + String(ref) }),
    prompt: async () => ({ ok: true, via: 'controller' }),
  })
  const engine = new TaskEngine(cfg, store, agents)
  await engine.boot()
  const providers = new Providers(cfg)
  const handler = makeHandler(cfg, {
    engine, agents, providers,
    effective: () => cfg,
    persistSettingsPatch: async (patch) => { Object.assign(cfg, patch); return 'test' },
  })
  return { handler, engine, cfg }
}

const BROWSER = {
  'content-type': 'application/json',
  'x-requested-with': 'dsh-conductor',
  'sec-fetch-site': 'same-origin',
  origin: 'http://127.0.0.1:3080',
  host: '127.0.0.1:3080',
  cookie: harnessCookieName('127.0.0.1:3080') + '=session-value',
}

const PREFIX = '/dsh-conductor/api'

test('api: health answers without a secret', async () => {
  await withTmp(async (dir) => {
    const { handler } = await makeApi(dir)
    const res = fakeRes()
    await handler(fakeReq({ url: PREFIX + '/health' }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
  })
})

test('api: browser POST without CSRF headers is refused', async () => {
  await withTmp(async (dir) => {
    const { handler } = await makeApi(dir)
    const res = fakeRes()
    await handler(fakeReq({ method: 'POST', url: PREFIX + '/tasks', headers: { ...BROWSER, 'x-requested-with': 'evil' }, body: {} }), res)
    assert.equal(res.statusCode, 403)
  })
})

test('api: machine requests without a secret fail closed', async () => {
  await withTmp(async (dir) => {
    const { handler } = await makeApi(dir)
    const res = fakeRes()
    await handler(fakeReq({ method: 'POST', url: PREFIX + '/remote/run', headers: { 'x-conductor-secret': 'wrong-secret-aaaa' }, body: { kind: 'probe' } }), res)
    assert.equal(res.statusCode, 503)
  })
})

test('api: machine secret unlocks remote run + prompt', async () => {
  await withTmp(async (dir) => {
    const { handler } = await makeApi(dir, { secret: 'test-machine-secret-1' })
    const res = fakeRes()
    await handler(fakeReq({
      method: 'POST', url: PREFIX + '/remote/run',
      headers: { 'x-conductor-secret': 'test-machine-secret-1' },
      body: { kind: 'probe' },
    }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)

    const res2 = fakeRes()
    await handler(fakeReq({
      method: 'POST', url: PREFIX + '/remote/prompt',
      headers: { 'x-conductor-secret': 'test-machine-secret-1' },
      body: { chat: 'somechat', message: 'hi' },
    }), res2)
    assert.equal(res2.statusCode, 202)
    const j = res2.json()
    assert.equal(j.ok, true)
  })
})

test('api: bad secret is 401 and burns the auth budget', async () => {
  await withTmp(async (dir) => {
    const { handler } = await makeApi(dir, { secret: 'test-machine-secret-1' })
    // the auth-fail budget is 10 wrong attempts per IP per minute
    for (let i = 0; i < 10; i++) {
      const res = fakeRes()
      await handler(fakeReq({
        method: 'POST', url: PREFIX + '/remote/run',
        headers: { 'x-conductor-secret': 'wrong' + i },
        body: { kind: 'probe' },
      }), res)
      assert.equal(res.statusCode, 401)
    }
    const res = fakeRes()
    await handler(fakeReq({
      method: 'POST', url: PREFIX + '/remote/run',
      headers: { 'x-conductor-secret': 'wrong-final' },
      body: { kind: 'probe' },
    }), res)
    assert.equal(res.statusCode, 429)
  })
})

test('api: browser task create works with proper gates', async () => {
  await withTmp(async (dir) => {
    const { handler, engine } = await makeApi(dir)
    const res = fakeRes()
    await handler(fakeReq({
      method: 'POST', url: PREFIX + '/tasks',
      headers: { ...BROWSER },
      body: { type: 'command', command: 'echo api-test', runner: 'local' },
    }), res)
    assert.equal(res.statusCode, 200)
    const j = res.json()
    assert.equal(j.ok, true)
    await engine.waitSettled(j.task.id)
    const t = engine.get(j.task.id)
    assert.equal(t.status, 'completed')
    const o = engine.output(j.task.id)
    assert.ok(o.output.includes('api-test'))
  })
})

test('api: GET /tasks lists and /tasks/:id/output reads', async () => {
  await withTmp(async (dir) => {
    const { handler, engine } = await makeApi(dir)
    const r = await engine.create({ type: 'command', command: 'echo listed' })
    await engine.waitSettled(r.task.id)
    const res = fakeRes()
    await handler(fakeReq({ url: PREFIX + '/tasks' }), res)
    assert.equal(res.statusCode, 200)
    assert.ok(res.json().rows.some((t) => t.id === r.task.id))
    const res2 = fakeRes()
    await handler(fakeReq({ url: PREFIX + '/tasks/' + r.task.id + '/output' }), res2)
    assert.equal(res2.statusCode, 200)
    assert.ok(res2.json().output.includes('listed'))
  })
})

test('api: settings GET masks the secret, PUT persists', async () => {
  await withTmp(async (dir) => {
    const { handler, cfg } = await makeApi(dir, { secret: 'original-secret-value' })
    const res = fakeRes()
    await handler(fakeReq({ url: PREFIX + '/settings' }), res)
    const j = res.json()
    assert.equal(j.settings.api.secret, '')
    assert.equal(j.settings.api.secretConfigured, true)
    const res2 = fakeRes()
    await handler(fakeReq({
      method: 'PUT', url: PREFIX + '/settings',
      headers: { ...BROWSER },
      body: { tasks: { maxConcurrent: 3 } },
    }), res2)
    assert.equal(res2.statusCode, 200)
    assert.equal(cfg.tasks.maxConcurrent, 3)
    assert.equal(cfg.tasks.allowCommandTasks, true, 'a nested patch keeps the sibling fields')
    assert.equal(cfg.api.secret, 'original-secret-value', 'the secret is never lost by a settings write')
  })
})

test('api: unknown paths 404', async () => {
  await withTmp(async (dir) => {
    const { handler } = await makeApi(dir)
    const res = fakeRes()
    await handler(fakeReq({ url: PREFIX + '/nope' }), res)
    assert.equal(res.statusCode, 404)
  })
})
