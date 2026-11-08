/**
 * Browser half tests (node:test + jsdom + real react-dom).
 *
 * The bundle (lib/client.js) is executed the way the DSH browser loader runs
 * it (a fake window.__ModuleLoader__ plus require('react')). Every test calls
 * the module factory again, so module-level stores start empty. Pure helpers
 * are imported straight from src/client/*.js.
 *
 * Run: node test/client.mjs   (npm run build first; npm test runs it)
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'

import {
  fmtTokens, fmtClock, selectionTotal, wordDiff, meterModel, meterLevel, dropMessage, dropBlocker, sortItems,
} from '../src/client/format.js'
import { buildSettingsPatch, setPath } from '../src/client/settings-model.js'

function loadLibs() {
  for (const seed of [process.env.DSH_TEST_REQUIRE_SEED, import.meta.url].filter(Boolean)) {
    try {
      const req = createRequire(seed)
      const React = req('react')
      return { JSDOM: req('jsdom').JSDOM, React, act: React.act || req('react-dom/test-utils').act, createRoot: req('react-dom/client').createRoot }
    } catch { /* next seed */ }
  }
  return null
}
const libs = loadLibs()
if (!libs) {
  console.log('client.mjs: SKIP - jsdom/react not resolvable from this checkout (install devDependencies to run)')
  process.exit(0)
}
const { JSDOM, React, act, createRoot } = libs
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:3080/' })
const w = dom.window
for (const k of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Node', 'MouseEvent', 'KeyboardEvent', 'Event']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true })
}
// React 18's input polyfill takes an old IE path under jsdom on focus changes; give it the no-op it expects
w.HTMLElement.prototype.attachEvent = function attachEvent() {}
w.HTMLElement.prototype.detachEvent = function detachEvent() {}
const originalConsoleError = console.error
console.error = (...args) => {
  if (String(args[0] || '').includes('not wrapped in act')) return
  originalConsoleError(...args)
}

const BUNDLE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const SID = 'session-alpha'
const TAB_ID = 'dsh-conductor:main'

// ── fixtures ───────────────────────────────────────────────────────────

const now = Date.now()
const iso = (msAgo) => new Date(now - msAgo).toISOString()

function viewFixture(over = {}) {
  return {
    ok: true,
    fingerprint: 'fp-1',
    sessionId: SID,
    status: 'idle',
    model: { window: 200000, provider: 'mock', model: 'mock-1' },
    meter: { total: 86000, window: 200000, categories: { system: 2000, tools: 20000, context: 3000, user: 5000, assistant: 30000, tool: 24000, checkpoint: 2000, conductor: 0 } },
    items: [
      { seq: 1, index: 0, type: 'system/message', role: 'system', category: 'system', label: 'System prompt', preview: 'You are...', chars: 8000, tokens: 2000, pinned: false, droppable: false, time: iso(600000) },
      { seq: 2, index: 1, type: 'developer/message', role: 'developer', category: 'context', label: 'Context: agent-instructions', preview: 'rules', chars: 12000, tokens: 3000, pinned: false, droppable: true, time: iso(600000) },
      { seq: 3, index: 2, type: 'user/message', role: 'user', category: 'user', source: 'user', messageId: 'm-user-1', label: 'Please read the client', preview: 'Please read the client', chars: 400, tokens: 5000, pinned: false, droppable: true, time: iso(500000) },
      { seq: 4, index: 3, type: 'assistant/message', role: 'assistant', category: 'assistant', messageId: 'm-asst-1', label: 'Calls read', preview: '', chars: 300, tokens: 1000, pinned: false, droppable: true, time: iso(400000) },
      { seq: 5, index: 4, type: 'tool/result', role: 'tool', category: 'tool', tool: 'read', label: 'read: src/client.jsx', preview: 'line 1\nline 2', chars: 72000, tokens: 18200, pinned: false, droppable: true, time: iso(400000) },
      { seq: 6, index: 5, type: 'tool/result', role: 'tool', category: 'tool', tool: 'bash', label: 'bash: ls -la', preview: 'total 8', chars: 16000, tokens: 4000, pinned: false, droppable: true, time: iso(300000) },
      { seq: 7, index: 6, type: 'assistant/message', role: 'assistant', category: 'assistant', messageId: 'm-asst-2', label: 'Here is the summary of the client', preview: 'Here is the summary of the client', chars: 4000, tokens: 29000, pinned: true, droppable: true, time: iso(200000) },
      { seq: 8, index: 7, type: 'tool/result', role: 'tool', category: 'tool', tool: 'grep', label: 'grep: TODO', preview: 'a', chars: 4000, tokens: 1800, pinned: false, droppable: true, pendingDrop: true, time: iso(100000) },
      { seq: 9, index: 8, type: 'user/message', role: 'user', category: 'conductor', source: 'dsh-conductor', label: '[A message was removed from context by the user]', preview: '[removed]', chars: 200, tokens: 50, pinned: false, droppable: false, dropped: { id: 'dr-1', at: iso(50000), by: 'user', undoable: true }, time: iso(50000) },
      { seq: 10, index: 9, type: 'user/message', role: 'user', category: 'checkpoint', source: 'compact-checkpoint', label: 'Handoff (from /new)', preview: '# Handoff', chars: 8000, tokens: 2000, pinned: false, droppable: false, time: iso(40000) },
    ],
    pins: [
      { id: 'pin-1', messageId: 'm-asst-2', seq: 7, role: 'assistant', text: 'Here is the summary of the client, with the plan.', by: 'user', at: iso(120000), tokens: 1200, note: 'the plan' },
    ],
    inbox: [
      { id: 'in-2', at: iso(30000), from: { label: 'chat "Build watcher"', sessionId: 'session-beta', by: 'user' }, kind: 'report', text: 'Deploy finished: 42 tests passed.\nDetails follow.', file: null, visible: 'user+model', read: false, delivered: 'appended' },
      { id: 'in-1', at: iso(900000), from: { label: 'a script', sessionId: null, by: 'script' }, kind: 'note', text: 'Nightly backup ok', file: null, visible: 'user', read: true, delivered: null },
    ],
    unread: 1,
    epochs: [
      { id: 'ep-1', at: iso(3600000), kind: 'new', by: 'user', tokensBefore: 212000, tokensAfter: 9000, archive: '/state/archive/ep1.md', handoff: '/state/handoffs/ep1.md', via: 'one-shot' },
    ],
    versions: [
      { messageId: 'm-asst-9', origSeq: 3, role: 'assistant', current: 3, replacementSeq: 99, versions: [
        { v: 1, text: 'The quick brown fox jumps', author: 'original', at: iso(9000000) },
        { v: 2, text: 'The quick red fox jumps high', author: 'user', at: iso(8000000), reason: 'colour' },
        { v: 3, text: 'The slow red fox jumps high', author: 'user', at: iso(7000000) },
      ] },
    ],
    drops: [],
    activity: [
      { at: iso(50000), kind: 'drop', text: 'Dropped 1 item(s), about 50 tokens', by: 'user' },
      { at: iso(3600000), kind: 'reset', text: '/new: 212K to 9K tokens', by: 'user' },
    ],
    progress: null,
    pending: { steps: 0, afterTurn: null },
    engine: 'ready',
    lastReset: null,
    ...over,
  }
}

const statusFixture = {
  ok: true,
  agents: { total: 2, live: 1, running: 1, rows: [
    { sessionId: SID, title: 'This chat', origin: 'chat', live: true, running: false, updatedAt: now - 1000 },
    { sessionId: 'session-beta', title: 'Build watcher', origin: 'subagent', parentSessionId: SID, live: true, running: true, updatedAt: now - 5000 },
  ] },
  tasks: { byStatus: { running: 1, completed: 1 }, rows: [
    { id: 'co-1', type: 'command', title: '$ echo hi', status: 'completed', runner: 'local', ownerSession: SID, createdAt: now - 60000, startedAt: now - 60000, finishedAt: now - 59000, outputPreview: 'hi' },
    { id: 'ag-2', type: 'agent', title: 'agent: research', status: 'running', runner: 'local', ownerSession: SID, createdAt: now - 30000, startedAt: now - 30000 },
  ] },
  runners: [{ id: 'local', label: 'This host', kind: 'local', enabled: true }],
  providers: [],
}

const settingsFixture = {
  ok: true,
  envSecretPresent: false,
  settings: {
    enabled: true, mirrorJobs: true, requireHarnessCookie: true, trustedHosts: [],
    api: { rateLimitPerMinute: 60, secretConfigured: true, secretFingerprint: 'sha256:1:ab12' },
    agents: { catalogMax: 120, transcriptMax: 60, spawnMax: 8, promptMaxChars: 24000, defaultPreset: '', defaultCwd: '' },
    tasks: { maxConcurrent: 4, historyKeep: 400, commandTimeoutMs: 600000, scrapeTimeoutMs: 30000, httpTimeoutMs: 30000, scrapeMaxUrls: 12, defaultRunner: 'local', allowCommandTasks: false, allowRemoteRunners: false },
    runners: [{ id: 'local', label: 'This host', kind: 'local', enabled: true }],
    providers: [],
    modules: { context: true, pins: true, posts: true, versions: true, orchestration: true },
    tools: { chat: true, chats: true, tasks: true, legacy: false },
    modelMay: { drop: true, edit: true, pin: true, new: true, compact: true, clear: false, post: true, prompt: true, spawn: true, cancel: true },
    handoffDir: '',
    posts: { maxChars: 8000, chatRow: true },
    resetTimeoutMs: 900000,
  },
}

// ── harness ────────────────────────────────────────────────────────────

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) }
}

/** A fake server: routes(method, path, body) may return [status, body], or undefined for the defaults. */
function server(routes = () => undefined, state = {}) {
  const calls = []
  const view = state.view || viewFixture()
  globalThis.fetch = w.fetch = (url, init = {}) => {
    const method = init.method || 'GET'
    const u = new URL(String(url), 'http://127.0.0.1:3080')
    const path = u.pathname.replace('/dsh-conductor/api', '')
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, query: u.search, body, headers: init.headers || {} })
    if (state.network) return Promise.reject(new TypeError('Failed to fetch'))
    const custom = routes(method, path, body, u)
    if (custom) return Promise.resolve(res(custom[0], custom[1]))
    if (method === 'GET' && path === '/conductor/session/' + SID) return Promise.resolve(res(200, view))
    if (method === 'GET' && path === '/status') return Promise.resolve(res(200, statusFixture))
    if (method === 'GET' && path === '/settings') return Promise.resolve(res(200, settingsFixture))
    if (method === 'GET' && path === '/runners') return Promise.resolve(res(200, { ok: true, rows: statusFixture.runners }))
    if (method === 'GET' && path === '/providers') return Promise.resolve(res(200, { ok: true, rows: [] }))
    if (method === 'GET' && path.startsWith('/agents')) return Promise.resolve(res(200, { ok: true, rows: statusFixture.agents.rows, messages: [] }))
    return Promise.resolve(res(200, { ok: true }))
  }
  return calls
}

/** Fresh plugin instance (new module scope: empty stores). */
function loadPlugin() {
  let loaded = null
  w.__ModuleLoader__ = { load: (pkg) => { loaded = pkg } }
  new Function('window', 'document', 'location', 'fetch', BUNDLE)(w, w.document, w.location, (...a) => globalThis.fetch(...a))
  assert.ok(loaded, '__ModuleLoader__.load was called')
  assert.equal(loaded.id, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name)
  return loaded.factory((id) => {
    assert.equal(id, 'react', 'the bundle may only require react, got ' + id)
    return React
  })
}

/** apply() against fake services; returns what was registered. */
function applyPlugin(plugin, opts = {}) {
  const reg = { tabs: [], slots: [], decorations: [], commands: [], opened: [], files: [], sessions: [], definitions: [] }
  const sidebar = {
    registerTab: (d) => { reg.tabs.push(d); return () => {} },
    openTab: (seed, scope) => { reg.opened.push({ seed, scope }) },
    openFile: (scope, path) => { reg.files.push({ scope, path }) },
  }
  const commandUi = {
    decorate: (d) => { reg.decorations.push(d); return () => {} },
    register: (c) => { reg.commands.push(c); return () => {} },
  }
  const uiWorkspace = { openSession: (id) => reg.sessions.push(id) }
  const uiConversation = { events: { register: (d) => { reg.definitions.push(d); return () => {} } } }
  const entries = opts.entries || {}
  const ctx = {
    effect: (fn) => fn(),
    ...(opts.noSidebar ? {} : { betterSidebar: sidebar }),
    ...(opts.noSlots ? {} : {
      slots: {
        inject: (name, provider) => provider(),
        register: (spec, component) => { reg.slots.push({ spec, component }); return () => {} },
        entries: (name) => entries[name] || [],
      },
    }),
    ...(opts.noInject ? {} : {
      inject: (names, cb) => {
        const services = { commandUi, uiWorkspace, uiConversation }
        cb({ get: (n) => services[n], effect: (fn) => fn() })
      },
    }),
  }
  plugin.apply(ctx)
  return reg
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const flush = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await sleep(0) })
}

const mounted = new Set()
async function mount(element) {
  const host = w.document.createElement('div')
  w.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(element) })
  await flush()
  const handle = {
    host,
    unmount: async () => {
      if (!mounted.has(handle)) return
      mounted.delete(handle)
      await act(async () => root.unmount())
      host.remove()
    },
  }
  mounted.add(handle)
  return handle
}
// a failed assertion must not leave a polling tab behind (the run would never exit)
afterEach(async () => {
  for (const handle of [...mounted]) await handle.unmount()
  w.localStorage.clear()
})

async function mountTab(reg, props = {}) {
  return mount(React.createElement(reg.tabs[0].component, { visible: true, scope: { sessionId: SID }, ...props }))
}

const click = async (el) => {
  assert.ok(el, 'element to click exists')
  await act(async () => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })) })
  await flush()
}
const key = async (el, k, extra = {}) => {
  await act(async () => { el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra })) })
  await flush()
}
const reactProps = (el) => {
  const k = Object.keys(el).find((x) => x.startsWith('__reactProps'))
  return k ? el[k] : {}
}
/** jsdom does not deliver synthetic input events to React 18; drive the real onChange. */
const typeInto = async (el, value) => {
  await act(async () => { reactProps(el).onChange({ target: { value }, preventDefault() {} }) })
  await flush()
}
const byText = (root, selector, text) => [...root.querySelectorAll(selector)].find((el) => el.textContent.trim() === text || el.textContent.includes(text))
/** Select a sub-tab and return its panel. */
const openTab = async (host, id) => {
  const btn = host.querySelector('[data-subtab=' + id + ']')
  assert.ok(btn, 'sub-tab ' + id + ' exists')
  if (btn.getAttribute('aria-selected') !== 'true') await click(btn)
  const panel = host.querySelector('[role=tabpanel]')
  assert.equal(panel.getAttribute('data-panel'), id)
  return panel
}
const lastToast = (host) => [...host.querySelectorAll('.cdx-toast')].at(-1)

w.localStorage.clear()

// ── pure helpers ───────────────────────────────────────────────────────

test('format: token and clock formatting matches the host', () => {
  assert.equal(fmtTokens(950), '950')
  assert.equal(fmtTokens(34100), '34.1K')
  assert.equal(fmtTokens(212000), '212K')
  assert.equal(fmtTokens(1500000), '1.5M')
  assert.equal(fmtClock(42000), '0:42')
  assert.equal(fmtClock(3723000), '1:02:03')
})

test('format: meter model folds host categories into groups and levels', () => {
  const m = meterModel(viewFixture().meter)
  assert.equal(m.percent, 43)
  assert.equal(m.free, 114000)
  const byId = Object.fromEntries(m.segments.map((s) => [s.id, s.tokens]))
  assert.deepEqual(byId, { system: 22000, instructions: 3000, handoff: 2000, messages: 35000, tools: 24000 })
  assert.equal(meterLevel(43, 80), 'ok')
  assert.equal(meterLevel(65, 80), 'warn')
  assert.equal(meterLevel(84, 80), 'bad')
  assert.equal(meterModel({ total: 5000, window: null, categories: {} }).percent, null)
})

test('format: drop selection math expands assistant steps and skips blocked rows', () => {
  const items = viewFixture().items
  // assistant step 4 takes its tool results 5 and 6; ticking 5 too must not double count
  let t = selectionTotal(items, [4, 5])
  assert.deepEqual(t.seqs, [4, 5])
  assert.deepEqual(t.expanded, [4, 5, 6])
  assert.equal(t.count, 2)
  assert.equal(t.tokens, 1000 + 18200 + 4000)
  // system (1), pinned (7), queued (8), dropped (9) and handoff (10) are never counted
  t = selectionTotal(items, [1, 7, 8, 9, 10, 3])
  assert.deepEqual(t.seqs, [3])
  assert.equal(t.tokens, 5000)
  assert.equal(dropBlocker(items[6]), 'Pinned. Unpin to drop.')
  assert.match(dropBlocker(items[7]), /next turn/)
  assert.equal(sortItems(items, 'size')[0].seq, 7)
  assert.equal(sortItems(items, 'age')[0].seq, 1)
})

test('format: drop toast copy is honest about queued outputs and steps', () => {
  assert.equal(dropMessage({ dropped: 3, queued: 0, tokens: 34100, undoable: ['a', 'b', 'c'] }), 'Dropped 3 items. 34.1K tokens freed.')
  assert.equal(dropMessage({ dropped: 0, queued: 2, tokens: 4000, undoable: [] }), '2 tool outputs leave the context when the next turn starts. 4K tokens freed.')
  assert.match(dropMessage({ dropped: 1, queued: 0, tokens: 900, undoable: [] }), /cannot be put back/)
  assert.equal(dropMessage({ ok: true, dropped: 0, queued: 0, tokens: 0, undoable: [], skipped: [{ seq: 3, reason: 'too small' }], text: 'Nothing dropped: too small.' }), 'Nothing dropped: too small.')
  assert.equal(dropMessage({ dropped: 1, queued: 0, tokens: 4000, undoable: ['x'], skipped: [{ seq: 3, reason: 'too small' }, { seq: 4, reason: 'too small' }] }), 'Dropped 1 item. 4K tokens freed. Skipped 2: too small.')
})

test('format: word diff round-trips both texts', () => {
  const a = 'The quick brown fox jumps'
  const b = 'The quick red fox jumps high'
  const parts = wordDiff(a, b)
  assert.equal(parts.filter((p) => p.type !== 'add').map((p) => p.text).join(''), a)
  assert.equal(parts.filter((p) => p.type !== 'del').map((p) => p.text).join(''), b)
  assert.ok(parts.some((p) => p.type === 'del' && p.text.includes('brown')))
  assert.ok(parts.some((p) => p.type === 'add' && p.text.includes('high')))
  assert.deepEqual(wordDiff('one two three', 'four five six'), [{ type: 'del', text: 'one two three' }, { type: 'add', text: 'four five six' }], 'a changed run reads as one deletion then one addition')
  assert.deepEqual(wordDiff('keep a b keep', 'keep c d keep').map((p) => p.type), ['same', 'del', 'add', 'same'])
  const big = wordDiff('x '.repeat(3000), 'y '.repeat(3000))
  assert.equal(big.filter((p) => p.type === 'del').length, 1, 'a huge middle falls back to one deletion plus one addition')
})

test('settings model: the PUT patch carries every new group with the right shape', () => {
  const form = setPath(setPath(settingsFixture.settings, ['modules', 'posts'], false), ['handoffDir'], '  /data/handoffs  ')
  const patch = buildSettingsPatch(setPath(form, ['modelMay', 'clear'], true))
  assert.deepEqual(Object.keys(patch).sort(), ['agents', 'api', 'enabled', 'handoffDir', 'mirrorJobs', 'modelMay', 'modules', 'posts', 'providers', 'requireHarnessCookie', 'resetTimeoutMs', 'runners', 'tasks', 'tools', 'trustedHosts'])
  assert.equal(patch.modules.posts, false)
  assert.equal(patch.modelMay.clear, true)
  assert.equal(patch.handoffDir, '/data/handoffs')
  assert.deepEqual(patch.posts, { maxChars: 8000, chatRow: true })
  assert.equal(patch.resetTimeoutMs, 900000)
  assert.equal(patch.tasks.allowCommandTasks, false)
  assert.equal(patch.api.secret, undefined, 'the secret never rides the settings patch')
})

// ── registration contract ──────────────────────────────────────────────

test('contract: object form, inject list, tab descriptor, slots and commands', () => {
  server()
  const plugin = loadPlugin()
  assert.equal(plugin.name, 'dsh-conductor')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.default, undefined, 'a default export would shadow the object form')
  assert.deepEqual(plugin.inject, ['betterSidebar', 'slots', 'locale'])
  const reg = applyPlugin(plugin)
  assert.equal(reg.tabs.length, 1)
  const tab = reg.tabs[0]
  assert.equal(tab.id, TAB_ID)
  assert.equal(tab.title, 'Conductor')
  assert.equal(tab.order, 85)
  assert.equal(tab.single, true)
  assert.equal(typeof tab.icon, 'function')
  assert.ok(tab.icon(16))
  assert.equal(typeof tab.badge, 'function')
  assert.equal(tab.badge({}, { sessionId: SID }, {}), null, 'no badge before any data')
  assert.deepEqual(tab.settings.pluginToggles.map((t) => t.key), ['autoPoll', 'undoSeconds', 'warnPercent', 'inboxBadge', 'autoOpenInbox'])
  const actions = reg.slots.filter((s) => s.spec.name === 'conversation.chat.assistant-actions')
  assert.deepEqual(actions.map((s) => s.spec.id), ['dsh-conductor-pin', 'dsh-conductor-version'])
  assert.deepEqual(actions[0].spec.inject(SID), { sessionId: SID })
  const settings = reg.slots.find((s) => s.spec.name === 'settings.section')
  assert.equal(settings.spec.id, 'dsh-conductor')
  assert.equal(settings.spec.label(), 'Conductor')
  assert.deepEqual(reg.decorations.map((d) => d.name), ['drop'])
  assert.equal(reg.decorations[0].ui.kind, 'action')
  assert.deepEqual(reg.commands.map((c) => c.name), ['conductor', 'pins', 'inbox', 'versions'])
  for (const c of reg.commands) {
    assert.equal(c.ui.kind, 'action')
    assert.equal(typeof c.label(), 'string')
    assert.equal(typeof c.description(), 'string')
    assert.equal(c.available({ sessionId: SID }), true)
  }
  // the ghost Definition and its renderer
  assert.deepEqual(reg.definitions.map((d) => d.kind), ['conductor-ghost', 'conductor-rewind'])
  assert.equal(reg.definitions[0].target, 'chat')
  const ghost = reg.slots.find((s) => s.spec.name === 'conversation.chat.node' && s.spec.key === 'conductor-ghost')
  assert.ok(ghost, 'ghost renderer registered')
  assert.deepEqual(ghost.spec.inject(SID), { conductorSessionId: SID })
})

test('contract: missing or throwing services only warn, never throw', () => {
  server()
  const warnings = []
  const origWarn = console.warn
  const origErr = console.error
  console.warn = (m) => warnings.push(String(m))
  console.error = (m) => warnings.push(String(m))
  try {
    const reg = applyPlugin(loadPlugin(), { noSidebar: true, noSlots: true, noInject: true })
    assert.equal(reg.tabs.length, 0)
    assert.ok(warnings.some((m) => m.includes('betterSidebar')))
    assert.ok(warnings.some((m) => m.includes('ctx.slots unavailable')))
    assert.doesNotThrow(() => loadPlugin().apply({
      effect: (fn) => fn(),
      betterSidebar: { registerTab: () => { throw new Error('boom') } },
      slots: { inject: () => { throw new Error('slot boom') }, register: () => () => {}, entries: () => { throw new Error('no') } },
      inject: (names, cb) => cb({ get: () => ({ decorate: () => { throw new Error('dup') }, register: () => { throw new Error('dup') }, events: { register: () => { throw new Error('dup') } } }), effect: (fn) => fn() }),
    }))
  } finally {
    console.warn = origWarn
    console.error = origErr
  }
})

test('commands: /drop and the section commands open the tab on their sub-tab', async () => {
  server()
  const reg = applyPlugin(loadPlugin())
  reg.decorations[0].ui.run({ sessionId: SID })
  assert.equal(reg.opened.length, 1)
  assert.equal(reg.opened[0].seed.type, TAB_ID)
  assert.equal(reg.opened[0].seed.target, 'right')
  assert.equal(reg.opened[0].seed.meta.section, 'context')
  assert.deepEqual(reg.opened[0].scope, { sessionId: SID })
  reg.commands.find((c) => c.name === 'versions').ui.run({ sessionId: SID })
  assert.equal(reg.opened[1].seed.meta.section, 'history', '/versions lives in History')
  const { host } = await mountTab(reg)
  assert.equal(host.querySelector('[data-subtab=history]').getAttribute('aria-selected'), 'true', 'the tab consumed the request')
})

// ── the chat seams ─────────────────────────────────────────────────────

test('chat: the ghost Definition claims silent posts exclusively and builds a bubble node', () => {
  server()
  const reg = applyPlugin(loadPlugin())
  const def = reg.definitions[0]
  const text = '[Silent message from chat "Build watcher", report, 2026-11-08T05:54:00.000Z. It did not wake you; take it into account when relevant.]\nBuild 1842 is green.'
  const event = { type: 'user/message', seq: 41, time: 1000, surfaceOp: 'append', data: { id: 'msg-9', role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-conductor-post', form: 'notice', summary: 'Message from chat' } } }
  const match = def.match(event)
  assert.deepEqual(match, { id: 'msg-9', role: 'start', exclusive: true })
  assert.equal(def.match({ ...event, surfaceOp: { op: 'replace' } }), null, 'replacement copies stay model-only')
  assert.equal(def.match({ ...event, data: { ...event.data, source: { kind: 'user' } } }), null, 'ordinary user messages are left to Chat')
  assert.equal(def.match({ type: 'assistant/message', seq: 1 }), null)
  const state = def.start({}, { event, location: { kind: 'step' } })
  assert.equal(state.from, 'chat "Build watcher"')
  assert.equal(state.kind, 'report')
  assert.equal(state.at, '2026-11-08T05:54:00.000Z')
  assert.equal(state.body, 'Build 1842 is green.')
  const node = def.buildViewNode({ key: 'k1', id: 'msg-9', state, start: { location: { kind: 'step' } } })
  assert.equal(node.kind, 'conductor-ghost')
  assert.equal(node.target, 'chat')
  assert.equal(node.visibility, 'visible')
  assert.equal(node.anchorSeq, 41)
  assert.equal(node.groupTree, 'input')
  assert.equal(def.buildViewNode({ key: 'k', id: 'x', state: undefined }), null)
})

test('chat: the ghost renderer shows sender, time, the Ghost label and the body; the label opens the Inbox', async () => {
  server()
  const reg = applyPlugin(loadPlugin())
  const Ghost = reg.slots.find((s) => s.spec.key === 'conductor-ghost').component
  const data = { seq: 41, time: Date.parse('2026-11-08T05:54:00Z'), messageId: 'msg-9', from: 'chat "Build watcher"', kind: 'alert', at: '2026-11-08T05:54:00.000Z', body: 'Disk at 91%.' }
  const { host } = await mount(React.createElement(Ghost, { node: { kind: 'conductor-ghost', data }, conductorSessionId: SID }))
  assert.ok(host.querySelector('[data-conductor-ghost="msg-9"]'))
  assert.equal(host.querySelector('.cdx-ghost-from').textContent, 'chat "Build watcher"')
  assert.equal(host.querySelector('.cdx-ghost-bubble').textContent, 'Disk at 91%.')
  assert.equal(host.querySelector('.cdx-ghost-kind').textContent, 'Alert')
  assert.ok(!host.textContent.includes('Silent message from'), 'the model-facing header is not shown')
  await click(byText(host, 'button', 'Ghost'))
  assert.equal(reg.opened.at(-1).seed.meta.section, 'inbox')
})

test('chat: edited messages delegate to the built-in renderers with the current version and a marker', async () => {
  const view = viewFixture({
    versions: [
      { messageId: 'm-user-1', origSeq: 3, role: 'user', current: 2, replacementSeq: 50, versions: [
        { v: 1, text: 'Please read the client', author: 'original', at: iso(9000) },
        { v: 2, text: 'Please read the client and the tests', author: 'user', at: iso(8000) },
      ] },
      { messageId: 'm-asst-2', origSeq: 7, role: 'assistant', current: 2, replacementSeq: 51, versions: [
        { v: 1, text: 'Here is the summary of the client', author: 'original', at: iso(9000) },
        { v: 2, text: 'Here is a shorter summary', author: 'user', at: iso(7000) },
      ] },
    ],
  })
  const calls = server((method, path) => (method === 'POST' && path.endsWith('/restore') ? [200, { ok: true, version: 3 }] : undefined), { view })
  const seen = { user: [], assistant: [] }
  const BuiltinUser = (props) => { seen.user.push(props); return React.createElement('div', { 'data-builtin-user': '' }, props.node.data.content.map((b) => b.text).join('|')) }
  const BuiltinAssistant = (props) => {
    seen.assistant.push(props)
    const reasoning = props.node.data.blocks.some((b) => b.kind === 'reasoning') ? props.renderSlot('conversation.chat.reasoning.body', { rawText: 'r', text: 'thinking', running: false }) : null
    return React.createElement('div', { 'data-builtin-assistant': '' }, props.node.data.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('|'), reasoning)
  }
  const entries = {
    'conversation.chat.node': [
      { component: BuiltinUser, options: { key: 'user' }, locale: 'chat' },
      { component: BuiltinAssistant, options: { key: 'assistant-step' }, locale: 'chat', inject: () => ({ hooks: { presentation: 'P' } }), children: { 'conversation.chat.reasoning.body': {} } },
    ],
  }
  const reg = applyPlugin(loadPlugin(), { entries })
  await flush(2)
  const user = reg.slots.find((s) => s.spec.name === 'conversation.chat.node' && s.spec.key === 'user')
  const asst = reg.slots.find((s) => s.spec.name === 'conversation.chat.node' && s.spec.key === 'assistant-step')
  assert.ok(user && asst, 'both shadows registered once the built-in entries exist')
  assert.equal(user.spec.priority, -100, 'lowest priority renders in a keyed cell')
  assert.equal(asst.spec.priority, -100)
  assert.equal(asst.spec.children, undefined, 'the built-in child slots are never declared twice')
  assert.deepEqual(asst.spec.inject(SID), { hooks: { presentation: 'P' }, conductorSessionId: SID }, 'the built-in injection rides along')

  // edited user message: current text, marker, version list with Restore
  const userNode = { kind: 'user', data: { kind: 'user', seq: 3, time: 1, content: [{ type: 'text', text: 'Please read the client' }, { type: 'image', id: 'img' }], source: { kind: 'user' } } }
  const u = await mount(React.createElement(user.component, { node: userNode, conductorSessionId: SID, t: (k) => k }))
  await flush(4)
  assert.equal(u.host.querySelector('[data-builtin-user]').textContent, 'Please read the client and the tests|', 'current version, other blocks kept')
  assert.equal(seen.user.at(-1).t('x'), 'x', 'the slot props reach the built-in renderer')
  const chip = u.host.querySelector('.cdx-vchip')
  assert.equal(chip.textContent, 'v2')
  await click(chip)
  assert.ok(u.host.querySelector('.cdx-vpop').textContent.includes('original'))
  await click(byText(u.host, '.cdx-vpop-btn', 'Restore'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/restore')).body, { messageId: 'm-user-1', version: 1 })

  // an unedited user message renders unchanged, without a marker
  const plain = await mount(React.createElement(user.component, { node: { ...userNode, data: { ...userNode.data, seq: 99 } }, conductorSessionId: SID }))
  await flush(2)
  assert.equal(plain.host.querySelector('[data-builtin-user]').textContent, 'Please read the client|')
  assert.ok(!plain.host.querySelector('.cdx-vchip'))

  // edited answer: text swapped, reasoning kept and rendered through the Factory
  const factory = []
  const renderFactorySlot = (name, props) => { factory.push({ name, props }); return React.createElement('i', { 'data-factory': name }, props.text) }
  const asstNode = { kind: 'assistant-step', data: { status: 'settled', blocks: [{ kind: 'reasoning', text: 'hm' }, { kind: 'text', text: 'Here is the summary of the client' }], finalNode: { messageId: 'm-asst-2', seq: 7, blocks: [] } } }
  const a = await mount(React.createElement(asst.component, { node: asstNode, conductorSessionId: SID, renderFactorySlot }))
  await flush(2)
  assert.ok(a.host.querySelector('[data-builtin-assistant]').textContent.startsWith('Here is a shorter summary'))
  assert.equal(factory[0].name, 'conversation.chat.reasoning.content')
  assert.deepEqual(factory[0].props, { text: 'thinking', running: false })
  // the marker of an answer sits in the action row
  const Version = reg.slots.find((s) => s.spec.id === 'dsh-conductor-version').component
  const mark = await mount(React.createElement(Version, { messageId: 'm-asst-2', sessionId: SID }))
  await flush(2)
  assert.equal(mark.host.querySelector('.cdx-vchip').textContent, 'v2')
})

test('chat: no built-in renderer means no shadow (the stock chat stays untouched)', async () => {
  server()
  const reg = applyPlugin(loadPlugin(), { entries: {} })
  await flush(2)
  assert.ok(!reg.slots.some((s) => s.spec.name === 'conversation.chat.node' && (s.spec.key === 'user' || s.spec.key === 'assistant-step')))
})

// ── the tab ────────────────────────────────────────────────────────────

test('tab: compact header, sub-tabs and every panel from a realistic view', async () => {
  const calls = server()
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  assert.ok(w.document.getElementById('dsh-conductor-styles'), 'stylesheet injected')
  assert.match(host.querySelector('[data-meter-numbers]').textContent, /86K of 200K\s*43%/)
  const bar = host.querySelector('[data-meter-bar]')
  assert.equal(bar.getAttribute('role'), 'img')
  assert.match(bar.getAttribute('aria-label'), /86 thousand of 200 thousand tokens used, 43 percent/)
  assert.ok(!host.querySelector('[data-seg]'), 'no always-on legend')
  await click(host.querySelector('[data-meter-numbers]'))
  assert.equal(host.querySelectorAll('[data-seg]').length, 5, 'the breakdown opens on demand')
  await click(host.querySelector('[data-seg=tools]'))
  assert.ok(host.textContent.includes('Tool results'), 'a category filters Context')
  await click(byText(host, 'button', 'Show every type'))
  // one primary button, the rest in the menu
  assert.ok(host.querySelector('[data-reset=new]'))
  assert.ok(!host.querySelector('[data-reset=clear]'))
  await click(host.querySelector('[data-more]'))
  assert.deepEqual([...host.querySelectorAll('[role=menuitem]')].map((m) => m.getAttribute('data-menu')), ['clear', 'force-compact', 'automation', 'refresh', 'setup'])
  await key(host.querySelector('[role=menu]'), 'Escape')
  assert.ok(!host.querySelector('[role=menu]'))
  // sub-tabs
  const tabs = [...host.querySelectorAll('[role=tab]')]
  assert.deepEqual(tabs.map((t) => t.getAttribute('data-subtab')), ['context', 'pins', 'inbox', 'history', 'agents'])
  assert.equal(host.querySelector('[role=tablist]').getAttribute('aria-label'), 'Conductor')
  assert.equal(host.querySelector('[data-subtab=inbox] .cdx-tcount').textContent, '1', 'unread count on Inbox')
  assert.equal(host.querySelectorAll('[role=tabpanel]').length, 1, 'one panel at a time')
  // Context: the 8 biggest items, a Drop each, honest states
  const rows = [...host.querySelectorAll('[data-panel=context] .cdx-row[data-seq]')]
  assert.equal(rows.length, 8)
  assert.equal(rows[0].getAttribute('data-seq'), '7', 'largest first')
  assert.ok(!host.querySelector('[data-drop-one="7"]'), 'a pinned item offers no Drop')
  assert.ok(!host.querySelector('[data-drop-one="1"]'), 'the system prompt offers no Drop')
  assert.ok(host.querySelector('[data-drop-one="5"]'))
  assert.ok(host.textContent.includes('Leaves at next turn'))
  assert.ok(!host.querySelector('[data-panel=context] input[type=checkbox]'), 'no checkboxes in the simple view')
  assert.equal(reg.tabs[0].badge({}, { sessionId: SID }, {}), 1, 'badge: unread first')
  // Pins
  let panel = await openTab(host, 'pins')
  assert.ok(panel.textContent.includes('1 pin, 1.2K tokens'))
  // Inbox
  panel = await openTab(host, 'inbox')
  assert.ok(panel.querySelector('.cdx-row.unread'))
  assert.equal(panel.querySelector('[data-inbox]').getAttribute('data-inbox'), 'in-2', 'unread first')
  assert.ok(panel.querySelector('[data-mark-all-read]'))
  // History: one timeline
  panel = await openTab(host, 'history')
  assert.ok(panel.querySelector('[data-history=reset]').textContent.includes('212K to 9K tokens'))
  assert.ok(panel.textContent.includes('saved 203K'))
  assert.ok(panel.querySelector('[data-history=edit]'))
  assert.ok(panel.textContent.includes('Dropped 1 item(s), about 50 tokens'), 'activity joins the timeline')
  assert.ok(!panel.textContent.includes('/new: 212K to 9K tokens'), 'reset activity is not repeated')
  await click(byText(panel, 'button', 'View handoff'))
  assert.deepEqual(reg.files.at(-1), { scope: { sessionId: SID }, path: '/state/handoffs/ep1.md' })
  // Agents: running now, the rest on demand
  panel = await openTab(host, 'agents')
  await flush()
  assert.ok(panel.textContent.includes('Running now'))
  assert.ok(panel.textContent.includes('Build watcher'))
  assert.ok(panel.textContent.includes('agent: research'))
  assert.ok(!panel.textContent.includes('Runners'))
  await click(panel.querySelector('[data-agents-all]'))
  assert.ok(panel.textContent.includes('Shell command tasks are off by default'))
  await click(panel.querySelector('[data-agents-more]'))
  assert.ok(panel.textContent.includes('Runners'))
  assert.ok(calls.some((c) => c.path === '/status'))
})

test('tab: arrow keys move between sub-tabs, the choice is remembered per chat', async () => {
  server()
  const reg = applyPlugin(loadPlugin())
  let m = await mountTab(reg)
  const first = m.host.querySelector('[data-subtab=context]')
  await act(async () => { first.focus() })
  await key(first, 'ArrowRight')
  assert.equal(m.host.querySelector('[data-subtab=pins]').getAttribute('aria-selected'), 'true')
  assert.equal(w.document.activeElement.getAttribute('data-subtab'), 'pins')
  await key(m.host.querySelector('[data-subtab=pins]'), 'End')
  assert.equal(m.host.querySelector('[data-subtab=agents]').getAttribute('aria-selected'), 'true')
  await key(m.host.querySelector('[data-conductor-root]'), '4', { altKey: true })
  assert.equal(m.host.querySelector('[data-subtab=history]').getAttribute('aria-selected'), 'true')
  assert.equal(m.host.querySelector('[data-subtab=history]').getAttribute('tabindex'), '0')
  assert.equal(m.host.querySelector('[data-subtab=context]').getAttribute('tabindex'), '-1')
  await m.unmount()
  m = await mountTab(reg)
  assert.equal(m.host.querySelector('[data-subtab=history]').getAttribute('aria-selected'), 'true', 'remembered')
  const other = await mount(React.createElement(reg.tabs[0].component, { visible: true, scope: { sessionId: 'session-other' } }))
  await flush()
  assert.ok(!other.host.querySelector('[data-subtab=history][aria-selected=true]'), 'per chat')
})

test('tab: polls with ?since= and skips the re-render on an unchanged answer', async () => {
  const calls = server((method, path, body, u) => (method === 'GET' && path === '/conductor/session/' + SID && u.searchParams.get('since') === 'fp-1' ? [200, { ok: true, unchanged: true, fingerprint: 'fp-1' }] : undefined))
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  const before = host.querySelector('[data-meter-numbers]')
  await click(host.querySelector('[data-more]'))
  await click(host.querySelector('[data-menu=refresh]'))
  const views = calls.filter((c) => c.path === '/conductor/session/' + SID)
  assert.equal(views[0].query, '')
  assert.equal(views.at(-1).query, '?since=fp-1')
  assert.equal(host.querySelector('[data-meter-numbers]'), before, 'same node, nothing re-rendered away')
})

test('tab: empty states and no session', async () => {
  server(() => undefined, { view: viewFixture({ items: [], pins: [], inbox: [], unread: 0, epochs: [], versions: [], activity: [], meter: { total: 0, window: 200000, categories: {} } }) })
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  assert.ok(host.textContent.includes('Context is empty'))
  assert.ok((await openTab(host, 'pins')).textContent.includes('No pinned messages'))
  assert.ok((await openTab(host, 'inbox')).textContent.includes('Inbox is empty'))
  assert.ok((await openTab(host, 'history')).textContent.includes('Nothing yet'))
  const none = await mount(React.createElement(reg.tabs[0].component, { visible: true, scope: {} }))
  assert.ok(none.host.textContent.includes('Open a chat to use Conductor.'))
})

test('tab: one Drop per row in the simple view, with Undo', async () => {
  const calls = server((method, path) => {
    if (method === 'POST' && path.endsWith('/drop')) return [200, { ok: true, dropped: 1, queued: 0, tokens: 5000, ids: ['dr-7'], undoable: ['dr-7'], skipped: [] }]
    if (method === 'POST' && path.endsWith('/undrop')) return [200, { ok: true, restored: 1 }]
    return undefined
  })
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  await click(host.querySelector('[data-drop-one="3"]'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/drop')).body, { seqs: [3] })
  assert.match(lastToast(host).textContent, /Dropped 1 item\. 5K tokens freed\./)
  await click(lastToast(host).querySelector('[data-toast-undo]'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/undrop')).body, { target: ['dr-7'] })
})

test('tab: Select several shows the full inspector; footer math, drop, toast and undo', async () => {
  const calls = server((method, path, body) => {
    if (method === 'POST' && path.endsWith('/drop')) return [200, { ok: true, dropped: 1, queued: 2, tokens: 27200, ids: ['dr-9'], undoable: ['dr-9'], skipped: [] }]
    if (method === 'POST' && path.endsWith('/undrop')) return [200, body.target === 'pending' ? { ok: true, cancelled: 2 } : { ok: true, restored: 1, queued: 0 }]
    return undefined
  })
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  await click(host.querySelector('[data-select-several]'))
  assert.equal(host.querySelectorAll('.cdx-row[data-seq]').length, 10, 'every item in the full view')
  assert.ok(host.textContent.includes('Dropped'))
  assert.equal(host.querySelector('[data-seq="1"] input').disabled, true, 'system prompt cannot be ticked')
  assert.equal(host.querySelector('[data-seq="7"] input').disabled, true, 'pinned item cannot be ticked')
  assert.match(host.querySelector('[data-seq="7"] label').getAttribute('title'), /Unpin to drop/)
  await click(host.querySelector('[data-seq="4"] input'))
  await click(host.querySelector('[data-seq="3"] input'))
  const footer = host.querySelector('[data-drop-footer]')
  assert.match(footer.textContent, /2 selected, 28.2K/)
  assert.match(host.querySelector('[data-drop]').textContent, /Drop 2 items \(28.2K\)/)
  await click(host.querySelector('[data-drop]'))
  const drop = calls.find((c) => c.method === 'POST' && c.path.endsWith('/drop'))
  assert.deepEqual(drop.body, { seqs: [3, 4] })
  assert.equal(drop.headers['x-requested-with'], 'dsh-conductor')
  assert.equal(drop.headers['content-type'], 'application/json')
  const toast = lastToast(host)
  assert.equal(toast.textContent.replace(/(Undo|Dismiss)/g, '').trim(), 'Dropped 1 item. 2 tool outputs leave the context when the next turn starts. 27.2K tokens freed.')
  assert.equal(toast.getAttribute('role'), 'status')
  assert.ok(!host.querySelector('[data-drop-footer]'), 'selection cleared')
  await click(toast.querySelector('[data-toast-undo]'))
  await flush(6)
  const undrops = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/undrop'))
  assert.deepEqual(undrops[0].body, { target: ['dr-9'] })
  assert.deepEqual(undrops[1].body, { target: 'pending' }, 'queued outputs are cancelled')
  assert.match(lastToast(host).textContent, /Put back 1 item\. Cancelled 2 queued drops: nothing had left the context yet\./)
  await click(host.querySelector('[data-simple-view]'))
  assert.ok(host.querySelector('[data-show-all]'), 'back to the simple view')
})

test('tab: keyboard in the full inspector, Ctrl+Z undoes', async () => {
  const calls = server((method, path) => {
    if (method === 'POST' && path.endsWith('/drop')) return [200, { ok: true, dropped: 1, queued: 0, tokens: 5000, ids: ['dr-2'], undoable: ['dr-2'], skipped: [] }]
    if (method === 'POST' && path.endsWith('/undrop')) return [200, { ok: true, restored: 1 }]
    return undefined
  })
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  await click(host.querySelector('[data-show-all]'))
  await act(async () => { host.querySelector('[data-seq="3"]').focus() })
  await key(host.querySelector('[data-seq="3"]'), 'x')
  assert.ok(host.querySelector('[data-seq="3"]').classList.contains('ticked'))
  await key(host.querySelector('[data-seq="3"]'), 'Delete')
  assert.ok(calls.some((c) => c.method === 'POST' && c.path.endsWith('/drop')))
  await key(host.querySelector('[data-conductor-root]'), 'z', { ctrlKey: true })
  await flush(4)
  assert.ok(calls.some((c) => c.method === 'POST' && c.path.endsWith('/undrop')), 'Ctrl+Z ran the undo')
})

test('tab: History expands an edit into its versions with a word diff and Restore', async () => {
  const calls = server((method, path) => (method === 'POST' && path.endsWith('/restore') ? [200, { ok: true, version: 4 }] : undefined))
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  const panel = await openTab(host, 'history')
  const row = panel.querySelector('[data-history=edit]')
  assert.ok(row.textContent.includes('3 versions'))
  await click(row)
  const diff = panel.querySelector('[data-diff]')
  assert.ok(diff, 'diff rendered')
  assert.ok(diff.querySelector('del').textContent.includes('quick'))
  assert.ok(diff.querySelector('ins').textContent.includes('slow'))
  await click(byText(panel, '.cdx-vrow', 'v1'))
  await click(byText(panel, 'button', 'Restore version 1'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/restore')).body, { messageId: 'm-asst-9', version: 1 })
  await click(byText(panel, '.cdx-chipbtn', 'Resets'))
  assert.ok(!panel.querySelector('[data-history=edit]'))
  assert.ok(panel.querySelector('[data-history=reset]'))
})

test('tab: pins unpin with undo and note, inbox read, dismiss with undismiss', async () => {
  const calls = server((method, path) => {
    if (method === 'POST' && path.endsWith('/unpin')) return [200, { ok: true, pin: { id: 'pin-1' } }]
    if (method === 'POST' && path.endsWith('/pin')) return [200, { ok: true, pin: { id: 'pin-2', tokens: 1200 } }]
    return undefined
  })
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  let panel = await openTab(host, 'pins')
  await click(panel.querySelector('[aria-label=Unpin]'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/unpin')).body, { target: 'pin-1' })
  assert.match(lastToast(host).textContent, /Unpinned\. 1.2K tokens/)
  await click(lastToast(host).querySelector('[data-toast-undo]'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/pin')).body, { target: 'm-asst-2', note: 'the plan' })
  await click(panel.querySelector('[aria-label="Edit note"]'))
  await typeInto(panel.querySelector('.cdx-detail input'), 'keep for the release')
  await click(byText(panel, 'button', 'Save note'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/pin-note')).body, { target: 'pin-1', note: 'keep for the release' })
  panel = await openTab(host, 'inbox')
  await click(panel.querySelector('[data-inbox="in-2"]'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/inbox')).body, { action: 'read', ids: ['in-2'] })
  assert.ok(panel.textContent.includes('Add to context'))
  await click(byText(panel, 'button', 'Open source chat'))
  assert.deepEqual(reg.sessions, ['session-beta'])
  await click(byText(panel, 'button', 'Dismiss'))
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/inbox')).at(-1).body, { action: 'dismiss', ids: ['in-2'] })
  assert.match(lastToast(host).textContent, /Dismissed 1 message\./)
  await click(lastToast(host).querySelector('[data-toast-undo]'))
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/inbox')).at(-1).body, { action: 'undismiss', ids: ['in-2'] })
})

test('tab: /new from the header shows live progress with Cancel, then the result with handoff links', async () => {
  let view = viewFixture()
  const calls = server((method, path) => {
    if (method === 'POST' && path.endsWith('/reset')) {
      view = viewFixture({ fingerprint: 'fp-2', progress: { kind: 'new', startedAt: Date.now() - 42000, by: 'user', elapsedMs: 42000 } })
      return [202, { ok: true, started: true }]
    }
    if (method === 'GET' && path === '/conductor/session/' + SID) return [200, view]
    return undefined
  })
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  await click(host.querySelector('[data-reset=new]'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/reset')).body, { kind: 'new' })
  await flush(6)
  const progress = host.querySelector('[data-reset-progress]')
  assert.ok(progress, 'progress card')
  assert.match(progress.textContent, /Writing handoff/)
  assert.match(progress.textContent, /0:4\d/)
  assert.ok(!/%/.test(progress.textContent), 'no fake percentage')
  await click(host.querySelector('[data-reset-cancel]'))
  assert.ok(calls.some((c) => c.method === 'POST' && c.path.endsWith('/reset/cancel')), 'Cancel calls reset/cancel')
  view = viewFixture({ fingerprint: 'fp-3', lastReset: { id: 'r1', kind: 'new', ok: true, text: 'Fresh context from a handoff: 86K to 9K tokens.\nHandoff: /h.md', at: new Date().toISOString(), ms: 40000 } })
  await act(async () => { await sleep(1700) }) // the 1.5 s reset poll picks the result up
  await flush(4)
  const result = host.querySelector('[data-reset-result]')
  assert.ok(result, 'result line')
  assert.match(result.textContent, /86K to 9K tokens/)
  assert.ok(!host.querySelector('[data-reset-progress]'))
  assert.ok([...host.querySelectorAll('.cdx-toast')].some((t) => /86K to 9K tokens/.test(t.textContent)), 'result toast')
  await click(byText(result, 'button', 'View handoff'))
  assert.equal(reg.files.at(-1).path, '/state/handoffs/ep1.md')
})

test('tab: Clear lives in the menu and asks first; a busy agent blocks resets', async () => {
  const calls = server()
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  await click(host.querySelector('[data-more]'))
  await click(host.querySelector('[data-menu=clear]'))
  assert.ok(!calls.some((c) => c.path.endsWith('/reset')), 'clear waits for confirmation')
  assert.ok(host.textContent.includes('There is no undo.'))
  await click(host.querySelector('[data-confirm-clear]'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/reset')).body, { kind: 'clear' })
  server(() => undefined, { view: viewFixture({ status: 'running' }) })
  const busy = await mountTab(applyPlugin(loadPlugin()))
  assert.equal(busy.host.querySelector('[data-reset=new]').disabled, true)
  assert.match(busy.host.querySelector('[data-reset=new]').getAttribute('title'), /agent is working/)
})

test('tab: offline, not loaded and server error states', async () => {
  server(() => undefined, { network: true })
  let m = await mountTab(applyPlugin(loadPlugin()))
  assert.ok(m.host.textContent.includes('Conductor can\u2019t reach its service. It will keep retrying.'))
  assert.ok(byText(m.host, 'button', 'Retry now'))
  await m.unmount()
  server((method, path) => (path.startsWith('/conductor/session/') ? [404, { ok: false, error: 'chat not found', code: 'not-found' }] : undefined))
  m = await mountTab(applyPlugin(loadPlugin()))
  assert.ok(m.host.textContent.includes('This chat is not loaded on the server yet.'))
  await m.unmount()
  server((method, path) => (path.startsWith('/conductor/session/') ? [500, { ok: false, error: 'kaboom' }] : undefined))
  m = await mountTab(applyPlugin(loadPlugin()))
  assert.ok(m.host.textContent.includes('Couldn\u2019t load Conductor. kaboom'))
})

test('tab: the silent post form posts to the chosen chat', async () => {
  const calls = server((method, path) => (method === 'POST' && path === '/conductor/post' ? [202, { ok: true, id: 'in-9' }] : undefined))
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  const panel = await openTab(host, 'inbox')
  await click(panel.querySelector('[data-post-toggle]'))
  await flush()
  const form = host.querySelector('[data-post-form]')
  assert.ok(form)
  const options = [...form.querySelector('select').options].map((o) => o.value)
  assert.ok(options.includes('session-beta'))
  assert.ok(!options.includes(SID), 'a chat cannot post to itself')
  await typeInto(form.querySelector('select'), 'session-beta')
  await typeInto(form.querySelector('textarea'), 'Deploy finished')
  await act(async () => { form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })) })
  await flush()
  assert.deepEqual(calls.find((c) => c.path === '/conductor/post').body, { to: 'session-beta', text: 'Deploy finished', kind: 'note', visible: 'user+model', fromSessionId: SID })
  assert.match(lastToast(host).textContent, /Posted silently to Build watcher/)
})

// ── the edited-message seam: loud fallback ─────────────────────────────

const editedView = () => viewFixture({
  versions: [
    { messageId: 'm-asst-2', origSeq: 7, role: 'assistant', current: 2, replacementSeq: 51, versions: [
      { v: 1, text: 'Here is the summary of the client', author: 'original', at: iso(9000) },
      { v: 2, text: 'Here is a shorter summary', author: 'user', at: iso(7000) },
    ] },
  ],
})

test('fallback: an unavailable chat seam shows the notice in History and on the row, warns once, keeps the answer marker', async () => {
  server(() => undefined, { view: editedView() })
  w.localStorage.setItem('dsh-conductor:simulate-no-chat-shadow', '1')
  const warnings = []
  const origWarn = console.warn
  console.warn = (m) => warnings.push(String(m))
  try {
    const reg = applyPlugin(loadPlugin(), { entries: { 'conversation.chat.node': [{ component: () => null, options: { key: 'user' } }, { component: () => null, options: { key: 'assistant-step' } }] } })
    await flush(2)
    assert.ok(!reg.slots.some((s) => s.spec.key === 'user' || s.spec.key === 'assistant-step'), 'no shadow registered')
    const { host } = await mountTab(reg)
    const panel = await openTab(host, 'history')
    const note = panel.querySelector('[data-edit-fallback]')
    assert.ok(note, 'notice shown')
    assert.equal(note.textContent, 'This DSH version does not let Conductor show edited text in the chat; the model still sees the new text. Versions are listed here.')
    assert.match(note.getAttribute('title'), /simulated/)
    assert.ok(panel.querySelector('[data-edit-fallback-row]'), 'the affected row says so too')
    await openTab(host, 'context')
    await openTab(host, 'history')
    assert.equal(warnings.filter((m) => m.includes('edited messages show their original text')).length, 1, 'one console warning')
    // the answer marker does not depend on the shadow
    const Version = reg.slots.find((s) => s.spec.id === 'dsh-conductor-version').component
    const mark = await mount(React.createElement(Version, { messageId: 'm-asst-2', sessionId: SID }))
    await flush(2)
    assert.equal(mark.host.querySelector('.cdx-vchip').textContent, 'v2')
  } finally {
    console.warn = origWarn
  }
})

test('fallback: once the shadow has rendered an edited message, History shows no notice', async () => {
  server(() => undefined, { view: editedView() })
  const Builtin = (props) => React.createElement('div', null, props.node.data.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join(''))
  const reg = applyPlugin(loadPlugin(), { entries: { 'conversation.chat.node': [{ component: () => null, options: { key: 'user' } }, { component: Builtin, options: { key: 'assistant-step' } }] } })
  await flush(2)
  const asst = reg.slots.find((s) => s.spec.key === 'assistant-step')
  const node = { kind: 'assistant-step', data: { status: 'settled', blocks: [{ kind: 'text', text: 'Here is the summary of the client' }], finalNode: { messageId: 'm-asst-2', seq: 7, blocks: [] } } }
  const a = await mount(React.createElement(asst.component, { node, conductorSessionId: SID }))
  await flush(3)
  assert.equal(a.host.textContent, 'Here is a shorter summary')
  const { host } = await mountTab(reg)
  const panel = await openTab(host, 'history')
  assert.ok(!panel.querySelector('[data-edit-fallback]'))
})

// ── first-run setup guide ──────────────────────────────────────────────

function setupServer(initial, opts = {}) {
  const state = { settings: { ...settingsFixture.settings, setupCompleted: initial, api: { ...settingsFixture.settings.api, secretConfigured: false, secretFingerprint: '' } } }
  const calls = server((method, path, body) => {
    if (method === 'GET' && path === '/settings') return [200, { ok: true, envSecretPresent: false, settings: state.settings }]
    if (method === 'PUT' && path === '/settings') {
      if (opts.failPut && opts.failPut(body)) return [500, { ok: false, error: 'settings not writable: no loader row for this plugin' }]
      state.settings = { ...state.settings, ...body }
      return [200, { ok: true }]
    }
    if (method === 'POST' && path === '/secret') return [200, { ok: true, configured: true, fingerprint: 'sha256:1:9f3a' }]
    return undefined
  })
  return { calls, state }
}
const puts = (calls) => calls.filter((c) => c.method === 'PUT' && c.path === '/settings').map((c) => c.body)

test('setup: a fresh install shows the guide; every step saves its own settings; finishing writes setupCompleted', async () => {
  const { calls } = setupServer('')
  const copied = []
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { copied.push(t) } } })
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  await flush(4)
  assert.ok(!host.querySelector('[role=tablist]'), 'the guide replaces the sub-tabs')
  assert.ok(host.querySelector('[data-reset=new]'), 'the header stays')
  assert.equal(host.querySelector('[data-setup-step]').getAttribute('data-setup-step'), 'welcome')
  assert.equal(host.querySelector('.cdx-dots').getAttribute('aria-label'), 'Step 1 of 6')
  assert.equal(host.querySelector('.cdx-dots [aria-current=step]').textContent, 'Current: Welcome')
  await click(host.querySelector('[data-setup-start]'))
  assert.equal(host.querySelector('[data-setup-step]').getAttribute('data-setup-step'), 'model')
  assert.equal(w.document.activeElement.id, 'cdx-setup-title', 'focus moves to the step title')
  const clear = host.querySelector('[role=switch][aria-label="Clear its context"]')
  assert.equal(clear.getAttribute('aria-checked'), 'false', 'clear is off by default')
  await click(clear)
  await click(host.querySelector('[data-setup-next]'))
  let body = puts(calls).at(-1)
  assert.deepEqual(Object.keys(body).sort(), ['modelMay', 'tools'])
  assert.equal(body.modelMay.clear, true)
  assert.equal(body.modelMay.drop, true, 'the full map is sent')
  assert.equal(body.tools.legacy, false)
  // automation: the global automatic level in three choices
  assert.equal(host.querySelector('[data-setup-step]').getAttribute('data-setup-step'), 'automation')
  await click(host.querySelector('[data-setup-handoff50]'))
  await click(host.querySelector('[data-setup-next]'))
  body = puts(calls).at(-1)
  assert.deepEqual(body, { autoCompact: { percent: 50, action: 'handoff', nudge: true } })
  // ghosts: Inbox switch and a generated secret that never reaches the DOM
  assert.equal(host.querySelector('[data-setup-step]').getAttribute('data-setup-step'), 'ghosts')
  await click(host.querySelector('[data-generate-secret]'))
  const secretCall = calls.find((c) => c.path === '/secret')
  assert.match(secretCall.body.secret, /^[A-Za-z0-9_-]{43}$/)
  assert.ok(!host.innerHTML.includes(secretCall.body.secret), 'the secret is never rendered')
  assert.match(host.querySelector('[data-secret-ready]').textContent, /fingerprint sha256:1:9f3a/)
  await click(host.querySelector('[data-copy-secret]'))
  await click(host.querySelector('[data-copy-usage]'))
  assert.deepEqual(copied, [secretCall.body.secret, 'dsh-post --kind report "<chat title>" "Build finished"   # reads DSH_CONDUCTOR_SECRET'])
  await click(host.querySelector('[role=switch][aria-label="Inbox and ghosts"]'))
  await click(host.querySelector('[data-setup-next]'))
  body = puts(calls).at(-1)
  assert.deepEqual(Object.keys(body), ['modules'])
  assert.equal(body.modules.posts, false)
  assert.equal(body.modules.orchestration, true)
  // agents: a warning appears when shell tasks are turned on; Skip saves nothing
  await click(host.querySelector('[role=switch][aria-label="Shell command tasks"]'))
  assert.ok(host.textContent.includes('Anything that can create a task can then run shell commands on this host.'))
  const before = puts(calls).length
  await click(host.querySelector('[data-setup-skip]'))
  assert.equal(puts(calls).length, before, 'Skip saves nothing')
  assert.equal(host.querySelector('[data-setup-step]').getAttribute('data-setup-step'), 'ready')
  // Escape never closes the guide
  await key(host.querySelector('[data-setup-step]'), 'Escape')
  assert.ok(host.querySelector('[data-setup-step=ready]'))
  await click(host.querySelector('[data-setup-finish]'))
  await flush(4)
  body = puts(calls).at(-1)
  assert.deepEqual(Object.keys(body), ['setupCompleted'])
  assert.ok(!Number.isNaN(Date.parse(body.setupCompleted)))
  assert.ok(host.querySelector('[role=tablist]'), 'the sub-tabs are back')
  delete w.navigator.clipboard
})

test('setup: Use defaults marks it done at once; an existing install never sees the guide', async () => {
  const { calls } = setupServer('')
  const reg = applyPlugin(loadPlugin())
  const { host, unmount } = await mountTab(reg)
  await flush(4)
  await click(host.querySelector('[data-setup-defaults]'))
  await flush(4)
  assert.equal(puts(calls).length, 1)
  assert.deepEqual(Object.keys(puts(calls)[0]), ['setupCompleted'])
  assert.ok(host.querySelector('[role=tablist]'))
  await unmount()
  setupServer('2026-11-08T07:00:00.000Z')
  const done = await mountTab(applyPlugin(loadPlugin()))
  await flush(4)
  assert.ok(!done.host.querySelector('[data-setup-step]'))
  assert.ok(done.host.querySelector('[role=tablist]'))
})

test('setup: a settings store that cannot be written is reported honestly, with Retry and Continue', async () => {
  let fail = true
  const { calls } = setupServer('', { failPut: () => fail })
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  await flush(4)
  await click(host.querySelector('[data-setup-start]'))
  await click(host.querySelector('[data-setup-next]'))
  const alert = host.querySelector('.cdx-wizard [role=alert]')
  assert.ok(alert)
  assert.match(alert.textContent, /Couldn\u2019t save: settings not writable: no loader row for this plugin\. Nothing on this step was changed\./)
  assert.equal(host.querySelector('[data-setup-step]').getAttribute('data-setup-step'), 'model', 'stays on the step')
  fail = false
  await click(byText(alert, 'button', 'Retry'))
  assert.equal(host.querySelector('[data-setup-step]').getAttribute('data-setup-step'), 'automation', 'Retry saved and moved on')
  fail = true
  await click(host.querySelector('[data-setup-next]'))
  await click(byText(host.querySelector('.cdx-wizard [role=alert]'), 'button', 'Continue without saving'))
  assert.equal(host.querySelector('[data-setup-step]').getAttribute('data-setup-step'), 'ghosts')
  assert.equal(calls.filter((c) => c.method === 'PUT').length, 3)
})

test('setup: Run setup guide again from the header menu and from Settings', async () => {
  const { calls } = setupServer('2026-11-08T07:00:00.000Z')
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  await flush(4)
  await click(host.querySelector('[data-more]'))
  await click(host.querySelector('[data-menu=setup]'))
  assert.equal(host.querySelector('[data-setup-step]').getAttribute('data-setup-step'), 'welcome')
  assert.equal(puts(calls).length, 0, 'a re-run changes nothing until it finishes')
  await click(host.querySelector('[data-setup-defaults]'))
  await flush(4)
  assert.ok(host.querySelector('[role=tablist]'))
  // from the Settings section
  const Section = reg.slots.find((s) => s.spec.name === 'settings.section').component
  const settingsPage = await mount(React.createElement(Section))
  await flush(2)
  await click(settingsPage.host.querySelector('[data-rerun-setup]'))
  assert.ok(settingsPage.host.textContent.includes('The setup guide opens in the Conductor tab.'))
  await flush(2)
  assert.ok(host.querySelector('[data-setup-step=welcome]'), 'the open tab switches to the guide')
})

// ── round 4: checkpoints, rewind, recall, automation ───────────────────

const automatedView = (over = {}) => viewFixture({
  level: { percent: 50, action: 'handoff', source: 'chat', nudge: true },
  autoNew: { daily: '03:00' },
  relay: { to: 'session-beta', label: 'Build watcher', since: iso(1000) },
  handoffTemplate: null,
  recovery: { enabled: true, conflict: false, chatDisabled: false, attempts: 1, maxAttempts: 5, waiting: false, fallback: 'deepseek-chat' },
  checkpoints: [
    { id: 'cp-3', kind: 'manual', at: iso(60000), boundarySeq: 40, label: 'Checkpoint', name: 'before refactor' },
    { id: 'cp-2', kind: 'turn', at: iso(120000), boundarySeq: 30, label: 'change the file', files: 2 },
    { id: 'cp-1', kind: 'turn', at: iso(180000), boundarySeq: 10, label: 'scheduled /new', auto: true },
  ],
  ...over,
})

test('automation: the summary line, the level tick and the Automation panel save each part', async () => {
  const calls = server((method, path) => {
    if (method === 'POST' && /\/(level|auto-new|relay|template|recovery)$/.test(path)) return [200, { ok: true, text: 'Saved.' }]
    return undefined
  }, { view: automatedView() })
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  const sum = host.querySelector('[data-automation-summary]')
  assert.equal(sum.textContent, 'Auto handoff at 50% \u00b7 /new daily 03:00 \u00b7 answers to Build watcher')
  assert.equal(host.querySelector('[data-level-tick]').style.left, '50%')
  await click(sum)
  const panel = host.querySelector('[data-automation]')
  assert.ok(panel, 'Automation replaces the sub-tabs')
  assert.ok(!host.querySelector('[role=tablist]'))
  // level: back to default, then a custom level from the slider (debounced)
  await click(byText(panel, 'label', 'Default'))
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/level')).at(-1).body, { off: true })
  const slider = panel.querySelector('[data-level-slider]')
  await typeInto(slider, '70')
  await act(async () => { await sleep(500) })
  await flush()
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/level')).at(-1).body, { percent: 70, action: 'handoff' })
  await click(panel.querySelector('[role=switch][aria-label="Pause the automatic level for this chat"]'))
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/level')).at(-1).body, { paused: true })
  // scheduled /new: every N turns
  await click(byText(panel, 'label', 'Every'))
  await click(panel.querySelector('[data-save-autonew]'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/auto-new')).body, { everyTurns: 40 })
  // relay off
  await typeInto(panel.querySelector('[data-relay]'), '')
  assert.deepEqual(calls.find((c) => c.path.endsWith('/relay')).body, { to: null })
  // template: start from the default, then save
  await click(byText(panel, 'label', 'Custom for this chat'))
  const customs = [...panel.querySelectorAll('label')].filter((l) => l.textContent === 'Custom for this chat')
  await click(customs.at(-1))
  await click(panel.querySelector('[data-template-default]'))
  assert.match(panel.querySelector('[data-template]').value, /^# Handoff\n## 1\. Role and standing orders/)
  await click(byText(panel, 'button', 'Save template'))
  assert.match(calls.find((c) => c.path.endsWith('/template')).body.template, /## 8\. Next step/)
  // recovery
  assert.match(panel.querySelector('[data-recovery-status]').textContent, /On \u00b7 1 of 5 attempts used \u00b7 fallback model deepseek-chat/)
  await click(panel.querySelector('[role=switch][aria-label="Recover this chat"]'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/recovery')).body, { enabled: false })
  await click(panel.querySelector('[data-automation-back]'))
  assert.ok(host.querySelector('[role=tablist]'), 'Back returns to the sub-tabs')
})

test('automation: recovery conflict, nothing active, and the menu entry', async () => {
  server(() => undefined, { view: viewFixture({ level: { percent: 0, action: 'compact', source: 'default', nudge: true }, autoNew: null, relay: null, recovery: { enabled: false, conflict: true, chatDisabled: false, attempts: 0, maxAttempts: 5, waiting: false, fallback: null } }) })
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  assert.ok(!host.querySelector('[data-automation-summary]'), 'no summary when nothing is active')
  assert.ok(!host.querySelector('[data-level-tick]'))
  await click(host.querySelector('[data-more]'))
  await click(host.querySelector('[data-menu=automation]'))
  assert.ok(host.textContent.includes('Off because dsh-continue is still installed; the migration replaces it.'))
})

test('history: checkpoints, the rewind panel with a file preview, rewind, branch, undo and the prompt', async () => {
  const preview = { checkpoint: { id: 'cp-2' }, files: [
    { path: '/tmp/lab/a.txt', action: 'restore', conflict: false },
    { path: '/tmp/lab/new.txt', action: 'delete', conflict: false },
    { path: '/tmp/lab/b.txt', action: 'restore', conflict: true },
  ] }
  let rewindReply = { ok: true, text: 'The conversation is back at the checkpoint before "change the file". Restored 2 files.', newChat: null, prompt: 'change the file', files: { done: ['/tmp/lab/a.txt', '/tmp/lab/new.txt'], conflicts: ['/tmp/lab/b.txt'], failed: [], undoId: 'restore-1' } }
  const calls = server((method, path) => {
    if (method === 'GET' && path.endsWith('/checkpoints')) return [200, { ok: true, checkpoints: [], preview }]
    if (method === 'POST' && path.endsWith('/rewind')) return [200, rewindReply]
    if (method === 'POST' && path.endsWith('/rewind/undo')) return [200, { ok: true, text: 'Put back 2 files as they were before the restore.' }]
    if (method === 'POST' && path.endsWith('/checkpoint')) return [200, { ok: true, text: 'Checkpoint "x" set.' }]
    return undefined
  }, { view: automatedView() })
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  const panel = await openTab(host, 'history')
  const rows = [...panel.querySelectorAll('[data-checkpoint]')]
  assert.deepEqual(rows.map((r) => r.getAttribute('data-checkpoint')), ['cp-3', 'cp-2', 'cp-1'], 'newest first')
  assert.ok(rows[0].textContent.includes('before refactor') && rows[0].querySelector('.cdx-chip.clay'), 'named manual checkpoint marked')
  assert.ok(rows[1].textContent.includes('2 files edited'))
  assert.ok(rows[2].classList.contains('auto'), 'automatic turn dimmed')
  // set a named checkpoint
  await click(panel.querySelector('[data-set-checkpoint]'))
  await typeInto(panel.querySelector('[aria-label="Checkpoint name"]'), 'before deploy')
  await click(panel.querySelector('[data-save-checkpoint]'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/checkpoint')).body, { name: 'before deploy' })
  // rewind panel
  await click(panel.querySelector('[data-rewind="cp-2"]'))
  await flush(3)
  assert.equal(calls.find((c) => c.path.endsWith('/checkpoints')).query, '?preview=cp-2')
  const rp = panel.querySelector('[data-rewind-panel]')
  assert.match(rp.querySelector('[data-file-plan]').textContent, /Files: 1 file restored, 1 file deleted; 1 changed outside the agent \(kept unless you overwrite\)\./)
  assert.ok(rp.textContent.includes('changed outside the agent'))
  const overwrite = byText(rp, 'label', 'Overwrite 1 file changed outside the agent')
  assert.ok(overwrite, 'overwrite offered only with conflicts')
  await click(rp.querySelector('[data-rewind-confirm]'))
  assert.deepEqual(calls.find((c) => c.path.endsWith('/rewind')).body, { target: 'cp-2', chat: true, files: true, branch: false, force: false })
  const res = panel.querySelector('[data-rewind-result]')
  assert.ok(res.textContent.includes('Restored 2 files.'))
  assert.ok(res.querySelector('[data-copy-prompt]'), 'no composer here: Copy the prompt')
  assert.equal(lastToast(host).querySelector('[data-toast-undo]').textContent, 'Undo file restore')
  await click(res.querySelector('[data-undo-files]'))
  assert.ok(calls.some((c) => c.path.endsWith('/rewind/undo')))
  // branch: files only, new chat
  rewindReply = { ok: true, text: 'New chat session-new continues from the checkpoint.', newChat: 'session-new', prompt: null, files: { done: [], conflicts: [], failed: [], undoId: null } }
  await click(byText(res, 'button', 'Close'))
  await click(panel.querySelector('[data-rewind="cp-3"]'))
  await flush(3)
  const rp2 = panel.querySelector('[data-rewind-panel]')
  await click(byText(rp2, 'label', 'Chat only'))
  await click(byText(rp2, 'label', 'Continue in a new chat'))
  await click(rp2.querySelector('[data-rewind-confirm]'))
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/rewind')).at(-1).body, { target: 'cp-3', chat: true, files: false, branch: true, force: false })
  await click(panel.querySelector('[data-open-branch]'))
  assert.deepEqual(reg.sessions, ['session-new'])
})

test('history: the prompt goes back into the input box through the conversation input facade', async () => {
  server((method, path) => {
    if (method === 'GET' && path.endsWith('/checkpoints')) return [200, { ok: true, checkpoints: [], preview: { files: [] } }]
    if (method === 'POST' && path.endsWith('/rewind')) return [200, { ok: true, text: 'Back.', newChat: null, prompt: 'change the file', files: { done: [], conflicts: [], failed: [], undoId: null } }]
    return undefined
  }, { view: automatedView() })
  const drafts = []
  const bctx = { get: (n) => (n === 'conversation' ? { input: { for: () => ({ setDraft: (t) => drafts.push(t), focus: () => {} }) } } : null) }
  const plugin = loadPlugin()
  const reg = { tabs: [], slots: [], definitions: [], opened: [], files: [], sessions: [] }
  plugin.apply({
    effect: (fn) => fn(),
    betterSidebar: { registerTab: (d) => { reg.tabs.push(d); return () => {} }, openTab: () => {}, openFile: () => {} },
    slots: { inject: (n, p) => p(), register: (spec, c) => { reg.slots.push({ spec, component: c }); return () => {} }, entries: () => [] },
    inject: (names, cb) => cb({ get: (n) => ({ sessions: { binding: () => ({ ctx: bctx }) } })[n], effect: (fn) => fn() }),
  })
  const { host } = await mountTab(reg)
  const panel = await openTab(host, 'history')
  await click(panel.querySelector('[data-rewind="cp-2"]'))
  await flush(2)
  await click(byText(panel, 'label', 'Chat only'))
  await click(panel.querySelector('[data-rewind-confirm]'))
  await click(panel.querySelector('[data-put-prompt]'))
  assert.deepEqual(drafts, ['change the file'])
})

test('history: search earlier context lists hits with kind, time and Open', async () => {
  const calls = server((method, path) => (method === 'GET' && path.endsWith('/recall') ? [200, { ok: true, searched: 3, hits: [{ path: '/state/archive/a.md', kind: 'archive', line: 12, endLine: 14, score: 3, snippet: 'the green button deploys', when: iso(3600000) }] }] : undefined))
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  const panel = await openTab(host, 'history')
  const box = panel.querySelector('[aria-label="Search earlier context"]')
  await typeInto(box, 'green button')
  await act(async () => { box.closest('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })) })
  await flush(3)
  assert.equal(calls.find((c) => c.path.endsWith('/recall')).query, '?q=green%20button&limit=10')
  const hit = panel.querySelector('[data-recall-hit]')
  assert.ok(hit.textContent.includes('archive') && hit.textContent.includes('line 12') && hit.textContent.includes('the green button deploys'))
  await click(byText(hit, 'button', 'Open'))
  assert.deepEqual(reg.files.at(-1), { scope: { sessionId: SID }, path: '/state/archive/a.md' })
})

test('history: a rewind epoch shows in the timeline with Undo file restore', async () => {
  const calls = server((method, path) => (method === 'POST' && path.endsWith('/rewind/undo') ? [200, { ok: true, text: 'Put back 1 file.' }] : undefined), {
    view: automatedView({ epochs: [{ id: 'ep-9', at: iso(1000), kind: 'rewind', by: 'user', tokensBefore: null, tokensAfter: null, checkpoint: 'cp-2', files: 1, branch: null }, ...viewFixture().epochs] }),
  })
  const reg = applyPlugin(loadPlugin())
  const { host } = await mountTab(reg)
  const panel = await openTab(host, 'history')
  const row = [...panel.querySelectorAll('[data-history=reset]')].find((r) => r.textContent.includes('Rewind'))
  assert.ok(row.textContent.includes('1 file restored'))
  await click(row.querySelector('[data-timeline-undo]'))
  assert.ok(calls.some((c) => c.path.endsWith('/rewind/undo')))
})

test('chat: the rewind Definition claims rewind notices and renders a divider that opens History', async () => {
  server()
  const reg = applyPlugin(loadPlugin())
  const def = reg.definitions.find((d) => d.kind === 'conductor-rewind')
  const event = { type: 'user/message', seq: 90, time: 5, surfaceOp: { op: 'replace', startSeq: 30, endSeq: 89 }, data: { id: 'rw-1', role: 'user', content: [{ type: 'text', text: '[The user rewound this chat to the checkpoint before "change the file" at 2026-11-08T08:00:00.000Z. Everything after...]' }], source: { kind: 'dsh-conductor-rewind', form: 'notice', summary: 'Rewound to: change the file' } } }
  assert.deepEqual(def.match(event), { id: 'rw-1', role: 'start', exclusive: true })
  assert.equal(def.match({ ...event, data: { ...event.data, source: { kind: 'user' } } }), null)
  const state = def.start({}, { event })
  assert.equal(state.label, 'change the file')
  assert.equal(def.start({}, { event: { ...event, data: { ...event.data, source: { kind: 'dsh-conductor-rewind' } } } }).label, 'change the file', 'falls back to the text')
  const node = def.buildViewNode({ key: 'k', id: 'rw-1', state, start: {} })
  assert.equal(node.kind, 'conductor-rewind')
  assert.equal(node.visibility, 'visible')
  const Divider = reg.slots.find((s) => s.spec.key === 'conductor-rewind').component
  const { host } = await mount(React.createElement(Divider, { node, conductorSessionId: SID }))
  const sep = host.querySelector('[role=separator]')
  assert.equal(sep.getAttribute('aria-label'), 'Rewound to before change the file')
  assert.equal(host.querySelector('.cdx-rewound-text').textContent, 'Rewound to before "change the file"')
  await click(host.querySelector('.cdx-rewound-text'))
  assert.equal(reg.opened.at(-1).seed.meta.section, 'history')
})

test('settings: automatic level, recovery and handoff template groups save through PUT', async () => {
  const calls = server((method, path) => (method === 'GET' && path === '/settings' ? [200, { ...settingsFixture, settings: { ...settingsFixture.settings, autoCompact: { percent: 0, action: 'compact', nudge: true }, recovery: { enabled: true, maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60000, hourlyCap: 20, continueTruncated: true, overflow: 'handoff', resumeCrashed: true, crashWindowMinutes: 20, fallbackProvider: '', fallbackModel: '', fallbackAfter: 3, resumeText: '' }, handoffTemplate: '' } }] : undefined))
  const reg = applyPlugin(loadPlugin())
  const Section = reg.slots.find((s) => s.spec.name === 'settings.section').component
  const { host } = await mount(React.createElement(Section))
  for (const g of ['Automatic level', 'Recovery', 'Handoff template']) assert.ok(host.textContent.includes(g), g)
  await typeInto(host.querySelector('[aria-label="Automatic level percent"]'), '60')
  await typeInto(host.querySelector('[aria-label="Action at the level"]'), 'handoff')
  await typeInto(host.querySelector('[aria-label="Fallback provider"]'), 'deepseek')
  await typeInto(host.querySelector('[aria-label="Fallback model"]'), 'deepseek-chat')
  await typeInto(host.querySelector('[aria-label="First wait (seconds)"]'), '3')
  await click(byText(host, 'button', 'Start from the default'))
  await click(host.querySelector('[data-save-settings]'))
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/settings').body
  assert.deepEqual(put.autoCompact, { percent: 60, action: 'handoff', nudge: true })
  assert.equal(put.recovery.fallbackProvider, 'deepseek')
  assert.equal(put.recovery.fallbackModel, 'deepseek-chat')
  assert.equal(put.recovery.baseDelayMs, 3000)
  assert.match(put.handoffTemplate, /^# Handoff/)
})

// ── the star ───────────────────────────────────────────────────────────

test('star: pressed state from the shared view, toggles pin and unpin', async () => {
  const calls = server((method, path) => {
    if (method === 'POST' && path.endsWith('/unpin')) return [200, { ok: true, pin: { id: 'pin-1' } }]
    if (method === 'POST' && path.endsWith('/pin')) return [200, { ok: true, pin: { id: 'pin-3', tokens: 800 } }]
    return undefined
  })
  const reg = applyPlugin(loadPlugin())
  const Star = reg.slots.find((s) => s.spec.name === 'conversation.chat.assistant-actions').component
  const a = await mount(React.createElement(Star, { messageId: 'm-asst-2', sessionId: SID }))
  const b = await mount(React.createElement(Star, { messageId: 'm-asst-1', sessionId: SID }))
  assert.equal(calls.filter((c) => c.path === '/conductor/session/' + SID).length, 1, 'one shared fetch for every star')
  const pinned = a.host.querySelector('button')
  assert.equal(pinned.getAttribute('aria-pressed'), 'true')
  assert.equal(pinned.getAttribute('aria-label'), 'Unpin')
  const free = b.host.querySelector('button')
  assert.equal(free.getAttribute('aria-pressed'), 'false')
  assert.equal(free.getAttribute('aria-label'), 'Pin to context')
  await click(pinned)
  assert.deepEqual(calls.find((c) => c.path.endsWith('/unpin')).body, { target: 'pin-1' })
  await click(free)
  assert.deepEqual(calls.find((c) => c.path.endsWith('/pin')).body, { target: 'm-asst-1' })
  await sleep(60)
  assert.match(w.document.getElementById('dsh-conductor-live').textContent, /Pinned\. 800 tokens added to context\./)
  await a.unmount()
  await b.unmount()
})

// ── settings section ───────────────────────────────────────────────────

test('settings: renders the new groups and saves through PUT /settings', async () => {
  const calls = server()
  const reg = applyPlugin(loadPlugin())
  const Section = reg.slots.find((s) => s.spec.name === 'settings.section').component
  const { host, unmount } = await mount(React.createElement(Section))
  const text = host.textContent
  for (const g of ['Modules', 'Model tools', 'The model may', 'Context', 'Silent posts', 'Agents', 'Tasks', 'Runners', 'Providers', 'Machine API']) assert.ok(text.includes(g), 'group ' + g)
  const sw = host.querySelector('[role=switch][aria-label="Silent posts and inbox"]')
  assert.equal(sw.getAttribute('aria-checked'), 'true')
  await click(sw)
  assert.equal(sw.getAttribute('aria-checked'), 'false')
  await typeInto(host.querySelector('[aria-label="Reset timeout in minutes"]'), '20')
  await click(host.querySelector('[data-save-settings]'))
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/settings')
  assert.ok(put, 'PUT /settings sent')
  assert.equal(put.body.modules.posts, false)
  assert.equal(put.body.resetTimeoutMs, 20 * 60000)
  assert.equal(put.body.modelMay.clear, false)
  assert.deepEqual(put.body.posts, { maxChars: 8000, chatRow: true })
  assert.ok(host.textContent.includes('Settings saved.'))
  await unmount()
})
