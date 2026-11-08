/**
 * dsh-conductor: dual settings tests (DSH 0.1.5 register mode, DSH 0.2.x
 * forms mode, no-service config mode), driven through the real apply().
 *
 * Needs the harness schemastery (>= 3.18.5 for volatile fields):
 *   DSH_GLOBAL_PREFIX=/var/tmp/dsh-mig/core node test/dual.mjs
 * Without a resolvable harness the 0.2 cases are skipped.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, Config } from '../lib/index.js'
import { loadHostSchemastery, isRef, plain, requireFromHarness } from '../lib/dual-settings.js'
import { harnessCookieName } from '../lib/security.js'

const z = loadHostSchemastery(import.meta.url)
const hasVolatile = Boolean(z && typeof z.prototype.volatile === 'function')
const WRITE = Symbol.for('cosmokit.volatile.write')
const PREFIX = '/dsh-conductor/api'
const BROWSER = {
  'content-type': 'application/json',
  'x-requested-with': 'dsh-conductor',
  'sec-fetch-site': 'same-origin',
  origin: 'http://127.0.0.1:3080',
  host: '127.0.0.1:3080',
  cookie: harnessCookieName('127.0.0.1:3080') + '=session-value',
}

// The live shape of Luca's legacy section (key names and value shapes only).
const LEGACY_YAML = [
  'dsh-conductor:',
  '  trustedHosts:',
  '    - app.example.com',
  '  providers:',
  '    - id: hpc',
  '      label: HPC',
  '      kind: hpc',
  '      url: http://127.0.0.1:3080/dsh-hpc/api',
  '      enabled: true',
  '      pollSeconds: 120',
  '  runners:',
  '    - id: local',
  '      label: This host',
  '      kind: local',
  '      enabled: true',
  '    - id: grey',
  '      label: Build box',
  '      kind: ssh',
  '      enabled: true',
  '      ssh:',
  '        target: build-box',
  '',
].join('\n')
const LEGACY = {
  trustedHosts: ['app.example.com'],
  providers: [{ id: 'hpc', label: 'HPC', kind: 'hpc', url: 'http://127.0.0.1:3080/dsh-hpc/api', enabled: true, pollSeconds: 120 }],
  runners: [
    { id: 'local', label: 'This host', kind: 'local', enabled: true },
    { id: 'grey', label: 'Build box', kind: 'ssh', enabled: true, ssh: { target: 'build-box' } },
  ],
}

function fakeReq({ method = 'GET', url = '/', headers = { host: '127.0.0.1:3080' }, body } = {}) {
  const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : []
  return { method, url, headers, socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c } }
}
function fakeRes() {
  const res = {
    statusCode: 0, headers: {}, body: '',
    setHeader: (k, v) => { res.headers[k.toLowerCase()] = v },
    writeHead: (code, hdrs) => { res.statusCode = code; Object.assign(res.headers, hdrs) },
    end: (text) => { res.body = String(text || '') },
  }
  res.json = () => JSON.parse(res.body || 'null')
  return res
}

/** Run fn with DSH_HOME pointing at a scratch dir and the console captured. */
async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'orch-dual-'))
  const saved = { DSH_HOME: process.env.DSH_HOME, DSH_CONDUCTOR_SECRET: process.env.DSH_CONDUCTOR_SECRET }
  process.env.DSH_HOME = home
  delete process.env.DSH_CONDUCTOR_SECRET
  const logs = []
  const origLog = console.log, origErr = console.error
  console.log = (...a) => logs.push(a.join(' '))
  console.error = (...a) => logs.push(a.join(' '))
  try {
    return await fn(home, logs)
  } finally {
    await new Promise((r) => setTimeout(r, 60)) // let the engine's first store write settle
    console.log = origLog; console.error = origErr
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

function until(logs, re, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (logs.some((l) => re.test(l))) return resolve()
      if (Date.now() - t0 > ms) return reject(new Error('timeout waiting for ' + re + '\n' + logs.join('\n')))
      setTimeout(tick, 10)
    }
    tick()
  })
}

/** Fake ctx common parts; `capture.handler` is the registered API route. */
function baseCtx(extra = {}) {
  const capture = {}
  const fiber = {}
  const ctx = {
    fiber,
    agents: { list: () => [], get: () => undefined },
    get: () => undefined,
    effect: (fn) => { try { fn() } catch {} },
    webServer: { register: (r) => { capture.handler = r.handler; return () => {} } },
    ...extra,
  }
  return { ctx, capture, fiber }
}

/** Fake 0.1.5 settings service: register() returns a scope over base + user layer. */
function fake015Settings({ user = {}, registrations = [] } = {}) {
  let layer = structuredClone(user)
  const watchers = new Set()
  const merge = (a, b) => (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b))
    ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? merge(a[k], b[k]) : a[k]])) : b
  return {
    register(ns, schema, opts) {
      registrations.push({ ns, applies: opts.applies, base: structuredClone(opts.base) })
      // like the real scope, values pass through the registered schema (defaults filled)
      const get = () => plain(schema(merge(structuredClone(opts.base), layer)))
      return {
        get,
        update: async (patch) => { const prev = get(); layer = merge(layer, structuredClone(patch)); for (const w of watchers) w(get(), prev) },
        watch: (cb) => { watchers.add(cb); return () => watchers.delete(cb) },
      }
    },
  }
}

/** Fake 0.2 forms service + loader entry; the row config is built by the HOST schemastery. */
function fake02(rowConfig = {}, { home } = {}) {
  let user = structuredClone(rowConfig)
  const config = Config(structuredClone(user))
  const writes = []
  const { ctx, capture, fiber } = baseCtx()
  const merge = (a, b) => (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b))
    ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? merge(a[k], b[k]) : a[k]])) : b
  ctx.settings = {
    describe: () => [{ ns: 'dsh-conductor', user: structuredClone(user) }],
    async update(id, patch) {
      assert.equal(id, 'dsh-conductor')
      for (const k of Object.keys(patch)) if (!Config.dict[k] || !Config.dict[k].meta.volatile) throw new Error(`Config field "${k}" is not volatile`)
      writes.push(structuredClone(patch))
      user = merge(user, JSON.parse(JSON.stringify(patch)))
      const next = Config(structuredClone(user))
      for (const [k, v] of Object.entries(config)) if (isRef(v)) v[WRITE](next[k].get())
    },
    configure: () => () => {},
  }
  ctx.loader = { entries: () => [{ options: { id: 'dsh-conductor', name: 'dsh-conductor' }, fiber }], await: async () => {} }
  ctx.profileContext = { home }
  return { ctx, capture, config, writes, getUser: () => user }
}

async function getSettings(handler) {
  const res = fakeRes()
  await handler(fakeReq({ url: PREFIX + '/settings' }), res)
  assert.equal(res.statusCode, 200)
  return res.json().settings
}
async function putSettings(handler, body) {
  const res = fakeRes()
  await handler(fakeReq({ method: 'PUT', url: PREFIX + '/settings', headers: BROWSER, body }), res)
  return res
}

test('Config: every top-level field is live except stateDir and compact; api.secret is a secret', { skip: !hasVolatile }, () => {
  assert.ok(Config, 'Config exported')
  for (const [k, f] of Object.entries(Config.dict)) {
    if (k === 'stateDir' || k === 'compact' || k === 'legacyRoute') assert.notEqual(f.meta.volatile, true)
    else assert.equal(f.meta.volatile, true, k + ' is live')
  }
  assert.equal(Config.dict.api.dict.secret.meta.role, 'secret')
})

test('Config: the legacy section validates against it', { skip: !hasVolatile }, () => {
  const out = Config(structuredClone(LEGACY))
  assert.equal(out.trustedHosts.get()[0], 'app.example.com')
  assert.equal(out.runners.get().length, 2)
  assert.equal(out.runners.get()[1].ssh.target, 'build-box')
  assert.equal(out.providers.get()[0].pollSeconds, 120)
})

test('0.1.5 register mode: namespace registered, settings win over Loader-filled row defaults', { skip: !hasVolatile }, async () => {
  await withHome(async (home) => {
    const registrations = []
    const { ctx, capture } = baseCtx({ settings: fake015Settings({ user: LEGACY, registrations }) })
    // the Loader validates the row against Config, so a bare row arrives fully defaulted
    apply(ctx, JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(Config({})).map(([k, v]) => [k, isRef(v) ? v.get() : v])))))
    assert.deepEqual(registrations.map((r) => [r.ns, r.applies]), [['dsh-conductor', 'live']])
    assert.equal(registrations[0].base.stateDir, join(home, 'dsh-conductor'))
    const s = await getSettings(capture.handler)
    assert.deepEqual(s.trustedHosts, ['app.example.com'], 'default [] in the row must not clobber settings')
    assert.equal(s.stateDir, join(home, 'dsh-conductor'))
    assert.deepEqual(s.runners.map((r) => r.id), ['local', 'grey'])
    assert.equal(s.providers[0].pollSeconds, 120)
  })
})

test('0.1.5 register mode: row config that differs from the defaults still applies as before', { skip: !hasVolatile }, async () => {
  await withHome(async (home) => {
    const { ctx, capture } = baseCtx({ settings: fake015Settings({ user: { tasks: { maxConcurrent: 7 } } }) })
    apply(ctx, { trustedHosts: ['row.example'], stateDir: join(home, 'elsewhere'), api: { rateLimitPerMinute: 5, secret: '' } })
    const s = await getSettings(capture.handler)
    assert.deepEqual(s.trustedHosts, ['row.example'], 'host-level fact: the row wins')
    assert.equal(s.stateDir, join(home, 'elsewhere'))
    assert.equal(s.tasks.maxConcurrent, 7, 'settings namespace value kept')
    assert.equal(s.api.rateLimitPerMinute, 60, 'settings namespace (base) wins over a row value for non-host keys')
  })
})

test('0.2 forms mode: legacy section is imported once into an empty row, then live', { skip: !hasVolatile }, async () => {
  await withHome(async (home, logs) => {
    await writeFile(join(home, 'settings.yaml.imported'), LEGACY_YAML)
    const f = fake02({}, { home })
    apply(f.ctx, f.config)
    await until(logs, /legacy settings import: imported/)
    assert.equal(f.writes.length, 1)
    assert.deepEqual(Object.keys(f.writes[0]).sort(), ['providers', 'runners', 'trustedHosts'])
    const s = await getSettings(f.capture.handler)
    assert.deepEqual(s.trustedHosts, ['app.example.com'])
    assert.deepEqual(s.runners.map((r) => r.id), ['local', 'grey'])
    // live update through the settings route, no remount
    const res = await putSettings(f.capture.handler, { tasks: { maxConcurrent: 2 } })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().store, 'settings')
    assert.equal(res.json().settings.tasks.maxConcurrent, 2)
    assert.equal((await getSettings(f.capture.handler)).tasks.maxConcurrent, 2)
    assert.equal(f.getUser().tasks.maxConcurrent, 2)
    assert.ok(f.writes.every((w) => Object.keys(w).every((k) => Config.dict[k].meta.volatile)), 'only live keys are ever written')
  })
})

test('0.2 forms mode: no overwrite when the row already has values', { skip: !hasVolatile }, async () => {
  await withHome(async (home, logs) => {
    await writeFile(join(home, 'settings.yaml'), LEGACY_YAML)
    const f = fake02({ trustedHosts: ['row.example'] }, { home })
    apply(f.ctx, f.config)
    await until(logs, /legacy settings import: already-configured/)
    assert.equal(f.writes.length, 0)
    const s = await getSettings(f.capture.handler)
    assert.deepEqual(s.trustedHosts, ['row.example'])
    assert.deepEqual(s.runners.map((r) => r.id), ['local'], 'legacy runners not applied')
  })
})

test('same effective config from the same legacy section on 0.1.5 and 0.2', { skip: !hasVolatile }, async () => {
  const outs = {}
  await withHome(async (home) => {
    const { ctx, capture } = baseCtx({ settings: fake015Settings({ user: LEGACY }) })
    apply(ctx, Object.fromEntries(Object.entries(Config({})).map(([k, v]) => [k, isRef(v) ? v.get() : v])))
    outs.register = await getSettings(capture.handler)
    outs.stateDir015 = join(home, 'dsh-conductor')
  })
  await withHome(async (home, logs) => {
    await writeFile(join(home, 'settings.yaml.imported'), LEGACY_YAML)
    const f = fake02({}, { home })
    apply(f.ctx, f.config)
    await until(logs, /legacy settings import: imported/)
    outs.forms = await getSettings(f.capture.handler)
    outs.stateDir02 = join(home, 'dsh-conductor')
  })
  assert.equal(outs.register.stateDir, outs.stateDir015)
  assert.equal(outs.forms.stateDir, outs.stateDir02)
  const strip = (o, dir) => ({ ...o, stateDir: o.stateDir === dir ? '<state>' : o.stateDir })
  assert.deepEqual(strip(outs.forms, outs.stateDir02), strip(outs.register, outs.stateDir015))
})

test('secrets: api.secret is redacted by describe() and by every GET, and survives a form write', { skip: !hasVolatile }, async () => {
  await withHome(async (home, logs) => {
    const f = fake02({}, { home })
    apply(f.ctx, f.config)
    const SECRET = 'a-long-enough-test-secret-value'
    const res = fakeRes()
    await f.capture.handler(fakeReq({ method: 'POST', url: PREFIX + '/secret', headers: BROWSER, body: { secret: SECRET } }), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.includes(SECRET), false)
    assert.equal(f.getUser().api.secret, SECRET, 'stored in the row')
    const g = fakeRes()
    await f.capture.handler(fakeReq({ url: PREFIX + '/settings' }), g)
    assert.equal(g.body.includes(SECRET), false)
    assert.equal(g.json().settings.api.secretConfigured, true)
    assert.equal(g.json().settings.api.secret, '')
    const h = fakeRes()
    await f.capture.handler(fakeReq({ url: PREFIX + '/health' }), h)
    assert.equal(h.body.includes(SECRET), false)
    // the host's own redaction removes the slot because of role('secret')
    const settingsMod = requireFromHarness('@deepseek-ai/dsh-settings', import.meta.url)
    if (settingsMod && typeof settingsMod.redactSecrets === 'function') {
      const red = settingsMod.redactSecrets(Config, { api: { rateLimitPerMinute: 60, secret: SECRET } })
      assert.equal(JSON.stringify(red.value).includes(SECRET), false)
      assert.ok(red.secrets.some((p) => p.path.join('.') === 'api.secret'))
    }
    // a later partial write keeps the secret
    await putSettings(f.capture.handler, { tasks: { maxConcurrent: 3 } })
    assert.equal(f.getUser().api.secret, SECRET)
  })
})

test('config mode (no settings service): JSON fallback file behaves as before', { skip: !hasVolatile }, async () => {
  await withHome(async (home) => {
    const dir = join(home, 'dsh-conductor')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(dir, 'settings.json'), JSON.stringify({ trustedHosts: ['file.example'], tasks: { maxConcurrent: 3 } }))
    const { ctx, capture } = baseCtx()
    // the Loader-filled row defaults must not clobber the file either
    apply(ctx, Object.fromEntries(Object.entries(Config({})).map(([k, v]) => [k, isRef(v) ? v.get() : v])))
    let s = await getSettings(capture.handler)
    assert.deepEqual(s.trustedHosts, ['file.example'])
    assert.equal(s.tasks.maxConcurrent, 3)
    const res = await putSettings(capture.handler, { tasks: { maxConcurrent: 5 } })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().store, 'fallback-file')
    assert.equal(JSON.parse(fs.readFileSync(join(dir, 'settings.json'), 'utf8')).tasks.maxConcurrent, 5)
    assert.equal(fs.statSync(join(dir, 'settings.json')).mode & 0o777, 0o600)
    s = await getSettings(capture.handler)
    assert.equal(s.tasks.maxConcurrent, 5)
    // a second apply reads the persisted file
    const again = baseCtx()
    apply(again.ctx, {})
    assert.equal((await getSettings(again.capture.handler)).tasks.maxConcurrent, 5)
  })
})
