/**
 * Unit tests for the Conductor host modules (no DSH, no network):
 * engine modes, surface planning and event shapes, side store, command
 * parsers and the model tool policy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installPatch, resolveConfig, handoffInstruction, clearPlaceholder } from '../lib/context/engine.js'
import { inventory, planDrop, applyDrop, applyUndrop, applyEdit, compactionOpen, categoryOf, messageOf, SOURCE_KIND } from '../lib/context/surface.js'
import { SessionStore, CAPS } from '../lib/conductor/store.js'
import { parseDrop, parsePost, parseForceCompact, parseFocus, contextSummary } from '../lib/conductor/commands.js'
import { conductorTools, DEFAULT_MODEL_POLICY } from '../lib/conductor/tools.js'
import { fmtTokens } from '../lib/conductor/service.js'

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-test-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

// ── a fake session: log + surface with replace semantics ─────────────────

function text(t) { return [{ type: 'text', text: t }] }

function fakeSession(id = 'session-test') {
  const events = []
  let nodes = []
  const session = {
    id,
    events,
    surface: { get nodes() { return nodes }, replaceGeneration: 0 },
    snapshotEvents: () => events,
    eventAt: (seq) => events.find((e) => e.seq === seq),
    append(type, data, opts) {
      const event = { type, seq: events.length, time: Date.now(), data, ...(opts?.surfaceOp ? { surfaceOp: opts.surfaceOp } : {}), ...(opts?.sourceEventSeqs ? { sourceEventSeqs: opts.sourceEventSeqs } : {}) }
      events.push(event)
      const op = opts?.surfaceOp
      if (op === 'append') nodes = [...nodes, event.seq]
      else if (op && typeof op === 'object') {
        const start = nodes.indexOf(op.startSeq)
        const end = nodes.indexOf(op.endSeq)
        assert.ok(start >= 0 && end >= start, 'replace range must be on the surface')
        nodes = [...nodes.slice(0, start), event.seq, ...nodes.slice(end + 1)]
        session.surface.replaceGeneration += 1
      }
      return event
    },
    deriveEventMessage: (event) => messageOf(event),
  }
  return session
}

function seed(session) {
  const s = session
  s.append('turn/start', {})
  s.append('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: text('You are a test agent.'), source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
  s.append('user/message', { id: 'u1', role: 'user', content: text('please read the config'), source: { kind: 'user' } }, { surfaceOp: 'append' })
  s.append('user/message', { id: 'ctx1', role: 'user', content: text('Current runtime context ...'), source: { kind: 'runtime-context' } }, { surfaceOp: 'append' })
  s.append('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"/etc/app.conf"}' }], source: { kind: 'model' } } }, { surfaceOp: 'append' })
  s.append('tool/result', { turn: 1, step: 1, message: { id: 't1', role: 'tool', toolCallId: 'call-1', content: text('x'.repeat(8000)), source: { kind: 'tool', callId: 'call-1' } } }, { surfaceOp: 'append' })
  s.append('assistant/message', { turn: 1, step: 2, message: { id: 'a2', role: 'assistant', content: text('The config sets port 8080.'), source: { kind: 'model' } } }, { surfaceOp: 'append' })
  s.append('turn/end', {})
  return s
}

const balanceAlways = { before: () => true, after: () => true }

// ── engine ───────────────────────────────────────────────────────────────

test('engine: handoff instruction carries the marker, every section and the focus', () => {
  const t = handoffInstruction('the deploy')
  assert.match(t, /^CONDUCTOR-HANDOFF/)
  for (const h of ['## 1. Role and standing orders', '## 4. Open items and pending requests', '## 6. Running work', '## 8. Next step']) assert.ok(t.includes(h), h)
  assert.match(t, /Never copy secret values/)
  assert.match(t, /particular attention to: the deploy/)
  assert.doesNotMatch(handoffInstruction(), /particular attention/)
  assert.doesNotMatch(t, /[\u2013\u2014]/, 'no en or em dashes in model-facing text')
})

test('engine: clear placeholder names the archive and keeps pins verbatim', () => {
  const t = clearPlaceholder({ path: '/a/archive.md' }, { pins: [{ role: 'user', text: 'Always use the green button.', note: 'rule' }] })
  assert.match(t, /cleared by the user/)
  assert.match(t, /\/a\/archive\.md/)
  assert.match(t, /Pinned messages[\s\S]*Always use the green button/)
})

function fakeProto(summary = 'REGULAR SUMMARY') {
  const calls = []
  const proto = {
    async summarize(input) {
      calls.push(input)
      return { summary: text(summary), provider: 'p', model: 'm' }
    },
  }
  return { proto, calls }
}

function engineState(dir, extra = {}) {
  const logs = []
  return {
    cfg: resolveConfig({ archiveDir: join(dir, 'archive'), handoffDir: join(dir, 'handoffs') }),
    forced: new Map(),
    log: (level, m) => logs.push(`${level}: ${m}`),
    logs,
    ...extra,
  }
}

const fakeAgent = (id = 'session-x') => ({ session: { id, toolHistory: () => ({}), requestHeader: () => undefined }, options: {} })
const sampleInput = () => ({ messages: [
  { role: 'system', content: text('sys') },
  { role: 'user', content: text('build it') },
  { role: 'assistant', content: text('done, port 8080') },
] })

test('engine: regular compaction archives, appends pins and reports the epoch', () => withTmp(async (dir) => {
  const { proto } = fakeProto()
  const epochs = []
  const state = engineState(dir, { onCompaction: (e) => epochs.push(e), pinsFor: () => [{ role: 'assistant', text: 'PINNED FACT' }] })
  const remove = installPatch(proto, state)
  const out = await proto.summarize(sampleInput(), fakeAgent(), undefined)
  const all = out.summary.map((b) => b.text).join('')
  assert.match(all, /REGULAR SUMMARY/)
  assert.match(all, /Archived Transcript/)
  assert.match(all, /PINNED FACT/)
  assert.equal(epochs.length, 1)
  assert.ok(existsSync(epochs[0].archive.path))
  remove()
}))

test('engine: clear mode makes no model call', () => withTmp(async (dir) => {
  const { proto, calls } = fakeProto()
  const state = engineState(dir)
  const remove = installPatch(proto, state)
  const run = {}
  state.forced.set('session-x', { mode: 'clear', run, pins: [] })
  const out = await proto.summarize(sampleInput(), fakeAgent(), undefined)
  assert.equal(calls.length, 0)
  assert.match(out.summary[0].text, /cleared by the user/)
  assert.ok(run.reached && run.archive?.path)
  remove()
}))

test('engine: handoff mode without the LLM seam falls back to the regular summary, still writes the handoff file', () => withTmp(async (dir) => {
  const { proto, calls } = fakeProto('FALLBACK NOTES')
  const state = engineState(dir)
  const remove = installPatch(proto, state)
  const run = {}
  state.forced.set('session-x', { mode: 'handoff', run, pins: [{ role: 'user', text: 'standing order X' }], focus: 'f' })
  // `this` has no ctx.llm, so the direct stream path is unavailable
  const out = await proto.summarize(sampleInput(), fakeAgent(), undefined)
  const all = out.summary.map((b) => b.text).join('')
  assert.equal(calls.length, 1)
  assert.match(all, /^# Handoff\n\nFALLBACK NOTES/)
  assert.match(all, /standing order X/)
  assert.match(all, /## Earlier history/)
  assert.equal(run.via, 'compaction-summary')
  assert.ok(run.handoff && existsSync(run.handoff))
  assert.match(await readFile(run.handoff, 'utf8'), /FALLBACK NOTES/)
  remove()
}))

test('engine: handoff mode with a model stream writes the model text verbatim', () => withTmp(async (dir) => {
  const { proto, calls } = fakeProto()
  const state = engineState(dir)
  const remove = installPatch(proto, state)
  const run = {}
  state.forced.set('session-x', { mode: 'handoff', run, pins: [] })
  const seen = []
  const engine = Object.create(proto)
  engine.config = {}
  engine.ctx = {
    llm: {
      async *stream(options) {
        seen.push(options)
        const body = '# Handoff\n## 1. Role and standing orders\n- MODEL WROTE THIS'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: body }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const agent = { ...fakeAgent(), options: { provider: 'p', model: 'm' } }
  const out = await engine.summarize(sampleInput(), agent, undefined)
  const all = out.summary.map((b) => b.text).join('')
  assert.equal(run.via, 'one-shot', 'the real BlockAssembler from the installed dsh-llm assembled the stream')
  assert.equal(calls.length, 0, 'no regular summary call')
  assert.equal(seen[0].purpose, 'compaction')
  assert.match(seen[0].messages.at(-1).content[0].text, /^CONDUCTOR-HANDOFF/)
  assert.equal(seen[0].messages.length, 4, 'full history plus the instruction')
  assert.match(all, /MODEL WROTE THIS/)
  remove()
}))

test('engine: installPatch is idempotent and the uninstaller restores the original', () => {
  const { proto } = fakeProto()
  const original = proto.summarize
  const a = installPatch(proto, engineState('/tmp'))
  const wrapped = proto.summarize
  const b = installPatch(proto, engineState('/tmp'))
  assert.equal(proto.summarize, wrapped, 'second install reuses the wrapper')
  a()
  assert.equal(proto.summarize, wrapped, 'a stale uninstaller does nothing')
  b()
  assert.equal(proto.summarize, original)
})

// ── surface ──────────────────────────────────────────────────────────────

test('surface: messageOf handles both event shapes; categories', () => {
  const s = seed(fakeSession())
  const ev = s.snapshotEvents()
  assert.equal(messageOf(ev.find((e) => e.type === 'user/message')).id, 'u1')
  assert.equal(messageOf(ev.find((e) => e.type === 'tool/result')).id, 't1')
  assert.equal(categoryOf(ev[1]), 'system')
  assert.equal(categoryOf(ev[3]), 'context')
  assert.equal(categoryOf(ev[5]), 'tool')
})

test('surface: inventory labels, sizes and droppability', () => {
  const s = seed(fakeSession())
  const items = inventory(s, { pinned: new Set(['a2']) })
  assert.equal(items.length, 6)
  assert.equal(items[0].droppable, false, 'system prompt')
  const tool = items.find((i) => i.category === 'tool')
  assert.equal(tool.label, 'read: /etc/app.conf')
  assert.ok(tool.tokens >= 2000)
  assert.equal(items.find((i) => i.messageId === 'a2').pinned, true)
  assert.equal(items.find((i) => i.messageId === 'a1').label, 'Reading.')
})

test('surface: planDrop selectors', () => {
  const s = seed(fakeSession())
  const items = inventory(s, { pinned: new Set(['a2']) })
  const tool = items.find((i) => i.category === 'tool')
  assert.deepEqual(planDrop(items, { last: 1 }, balanceAlways).ops.map((o) => o.start), [tool.seq])
  assert.equal(planDrop(items, { tool: 'read' }, balanceAlways).ops.length, 1)
  assert.equal(planDrop(items, { tool: 'read', keepNewest: 1 }, balanceAlways).ops.length, 0)
  assert.equal(planDrop(items, { file: 'app.conf' }, balanceAlways).ops.length, 1)
  assert.equal(planDrop(items, { larger: 1000 }, balanceAlways).ops.length, 1)
  assert.equal(planDrop(items, { larger: 100000 }, balanceAlways).ops.length, 0)
  const sys = planDrop(items, { seqs: [items[0].seq] }, balanceAlways)
  assert.equal(sys.ops.length, 0)
  assert.match(sys.skipped[0].reason, /system prompt/)
  const pinned = planDrop(items, { messageIds: ['a2'] }, balanceAlways)
  assert.match(pinned.skipped[0].reason, /pinned/)
  const step = planDrop(items, { messageIds: ['a1'] }, balanceAlways).ops[0]
  assert.equal(step.kind, 'step')
  assert.deepEqual(step.seqs, [items.find((i) => i.messageId === 'a1').seq, tool.seq], 'assistant expands to its tool results')
  assert.equal(planDrop(items, { messageIds: ['a1'] }, { before: () => true, after: () => false }).ops.length, 0, 'unbalanced step refused')
  assert.equal(planDrop(items, { messageIds: ['u1'] }, null).ops.length, 0, 'message drops need balance helpers')
})

test('surface: applyDrop keeps a tool result shape and changes only content; undrop restores it', () => {
  const s = seed(fakeSession())
  const events = new Map(s.snapshotEvents().map((e) => [e.seq, e]))
  const items = inventory(s)
  const op = planDrop(items, { last: 1 }, balanceAlways).ops[0]
  const placeholder = applyDrop(s, events, op, 'the user', '/saved.md')
  const before = events.get(op.start)
  assert.equal(placeholder.type, 'tool/result')
  assert.deepEqual(placeholder.sourceEventSeqs, [op.start])
  assert.deepEqual({ ...placeholder.data, message: { ...placeholder.data.message, content: null } }, { ...before.data, message: { ...before.data.message, content: null } })
  assert.match(placeholder.data.message.content[0].text, /^\[Tool output removed by the user: read: \/etc\/app\.conf, ~\d+ tokens\. Saved: `\/saved\.md`\]$/)
  const events2 = new Map(s.snapshotEvents().map((e) => [e.seq, e]))
  const restored = applyUndrop(s, events2, { kind: 'tool', start: op.start, placeholderSeq: placeholder.seq })
  assert.deepEqual(restored.data.message.content, before.data.message.content)
  assert.ok(s.surface.nodes.includes(restored.seq))
})

test('surface: a step drop becomes one user notice over a balanced range', () => {
  const s = seed(fakeSession())
  const events = new Map(s.snapshotEvents().map((e) => [e.seq, e]))
  const op = planDrop(inventory(s), { messageIds: ['a1'] }, balanceAlways).ops[0]
  const placeholder = applyDrop(s, events, op, 'the assistant', null)
  assert.equal(placeholder.type, 'user/message')
  assert.equal(placeholder.data.role, 'user')
  assert.equal(placeholder.data.source.kind, SOURCE_KIND)
  assert.ok(placeholder.data.source.summary.length <= 120)
  assert.deepEqual(placeholder.surfaceOp, { op: 'replace', startSeq: op.start, endSeq: op.end })
  assert.throws(() => applyUndrop(s, new Map(s.snapshotEvents().map((e) => [e.seq, e])), { kind: 'step', start: op.start, placeholderSeq: placeholder.seq }), /cannot be put back/)
})

test('surface: edits keep the user role for user messages, quote assistant answers', () => {
  const s = seed(fakeSession())
  const events = new Map(s.snapshotEvents().map((e) => [e.seq, e]))
  const userSeq = s.snapshotEvents().find((e) => e.data?.id === 'u1').seq
  const userEdit = applyEdit(s, events, userSeq, { text: 'please read the NEW config', role: 'user', version: 2, author: 'the user' })
  assert.equal(userEdit.data.source.kind, 'user')
  assert.equal(userEdit.data.content[0].text, 'please read the NEW config')
  assert.notEqual(userEdit.data.id, 'u1', 'fresh message id')
  const answerSeq = s.snapshotEvents().find((e) => e.data?.message?.id === 'a2').seq
  const edit = applyEdit(s, events, answerSeq, { text: 'Port 9090.', role: 'assistant', version: 2, author: 'the assistant', reason: 'wrong port' })
  assert.equal(edit.type, 'user/message')
  assert.match(edit.data.content[0].text, /^\[Your earlier answer, version 2, edited by the assistant: wrong port\]\nPort 9090\.$/)
})

test('surface: compactionOpen tracks brackets and seed boundaries', () => {
  const m = (types) => new Map(types.map((type, i) => [i, { type, seq: i }]))
  assert.equal(compactionOpen(m(['compaction/start'])), true)
  assert.equal(compactionOpen(m(['compaction/start', 'compaction/end'])), false)
  assert.equal(compactionOpen(m(['compaction/start', 'session/end-seed'])), false)
})

// ── store ────────────────────────────────────────────────────────────────

test('store: revisions, caps, durable round trip, unsafe ids', () => withTmp(async (dir) => {
  const store = new SessionStore(dir, { debounceMs: 5 })
  store.update('session-a', (s) => { s.pins.push({ id: 'p1' }) })
  for (let i = 0; i < CAPS.activity + 20; i += 1) store.activity('session-a', 'x', `line ${i}`)
  const state = store.get('session-a')
  assert.equal(state.activity.length, CAPS.activity)
  assert.equal(state.activity.at(-1).text, `line ${CAPS.activity + 19}`)
  assert.ok(state.rev > CAPS.activity)
  store.flush()
  const again = new SessionStore(dir)
  assert.equal(again.get('session-a').pins[0].id, 'p1')
  assert.deepEqual(again.known(), ['session-a'])
  assert.throws(() => store.update('../etc/passwd', () => {}), /invalid session id/)
  assert.equal(store.get('../x').pins.length, 0)
}))

test('store: pins are never trimmed silently', () => withTmp(async (dir) => {
  const store = new SessionStore(dir, { debounceMs: 5 })
  store.update('session-b', (s) => { for (let i = 0; i < CAPS.pins + 3; i += 1) s.pins.push({ id: `p${i}` }) })
  assert.equal(store.get('session-b').pins.length, CAPS.pins + 3, 'the service enforces the cap with a clear error instead')
  store.flush()
}))

// ── commands ─────────────────────────────────────────────────────────────

test('commands: /drop grammar', () => {
  assert.deepEqual(parseDrop('last'), { selector: { last: 1 } })
  assert.deepEqual(parseDrop('last 3'), { selector: { last: 3 } })
  assert.ok(parseDrop('last 0').error)
  assert.deepEqual(parseDrop('tool browser_snapshot keep 2'), { selector: { tool: 'browser_snapshot', keepNewest: 2 } })
  assert.deepEqual(parseDrop('file src/app.ts'), { selector: { file: 'src/app.ts' } })
  assert.deepEqual(parseDrop('larger 8K'), { selector: { larger: 8000 } })
  assert.deepEqual(parseDrop('12 #14'), { selector: { seqs: [12, 14] } })
  assert.equal(parseDrop('').empty, true)
  assert.equal(parseDrop('--help').help, true)
  assert.ok(parseDrop('banana').error)
})

test('commands: /post, /force-compact and focus parsing', () => {
  assert.deepEqual(parsePost('"Coordinator" report is ready'), { to: 'Coordinator', text: 'report is ready' })
  assert.deepEqual(parsePost('session-123 done'), { to: 'session-123', text: 'done' })
  assert.ok(parsePost('onlytarget').error)
  assert.equal(parsePost('').help, true)
  assert.deepEqual(parseForceCompact('--pointer keep paths'), { kind: 'pointer', focus: 'keep paths' })
  assert.deepEqual(parseForceCompact(''), { kind: 'force-compact', focus: undefined })
  assert.deepEqual(parseFocus('  the deploy  '), { focus: 'the deploy' })
})

test('commands: context summary lists the largest droppable items', () => {
  const s = seed(fakeSession())
  const items = inventory(s)
  const text = contextSummary({ meter: { total: 5000, window: 200000, categories: { tool: 2000, user: 100 } }, items })
  assert.match(text, /Context: 5K tokens of 200K \(3%\)/)
  assert.match(text, /read: \/etc\/app\.conf/)
  assert.doesNotMatch(text, /System prompt/)
})

test('fmtTokens', () => {
  assert.equal(fmtTokens(950), '950')
  assert.equal(fmtTokens(12600), '12.6K')
  assert.equal(fmtTokens(212000), '212K')
  assert.equal(fmtTokens(1500000), '1.5M')
  assert.equal(fmtTokens(undefined), '?')
})

// ── tools ────────────────────────────────────────────────────────────────

function fakeConductor() {
  const calls = []
  const rec = (name) => async (...args) => { calls.push([name, ...args]); return { ok: true, text: `${name} ok`, pin: { id: 'p' }, dropped: 1 } }
  return {
    calls,
    store: { get: () => ({ pins: [], versions: [], inbox: [] }) },
    view: async () => ({ meter: { total: 10, window: 100, categories: {} }, items: [] }),
    drop: rec('drop'), undrop: rec('undrop'), pin: rec('pin'), edit: rec('edit'), post: rec('post'),
    unpin: (...a) => { calls.push(['unpin', ...a]); return { ok: true, text: 'unpin ok' } },
    markRead: () => ({ changed: 2 }),
    scheduleReset: async (agent, kind, opts) => { calls.push(['reset', kind, opts]); return { ok: true, deferred: true, text: `${kind} later` } },
  }
}

function tools(conductor, policy = {}, switches) {
  const deps = { conductor, engine: {}, agents: {}, providers: {}, cfg: {}, probeRunners: () => {}, policy }
  return Object.fromEntries(conductorTools((o) => o, deps, switches ? { tools: switches } : undefined).map((d) => [d.name, d]))
}
const exec = { agent: { session: { id: 'session-z' }, status: 'running' } }

test('tools: three tools by default, legacy names only when enabled', () => {
  assert.deepEqual(Object.keys(tools(fakeConductor())), ['chat', 'chats', 'tasks'])
  const withLegacy = tools(fakeConductor(), {}, { chat: true, chats: true, tasks: true, legacy: true })
  assert.ok('orch_agent_prompt' in withLegacy && 'orch_task_create' in withLegacy)
  assert.equal(Object.keys(tools(fakeConductor(), {}, { chat: true, chats: false, tasks: false })).length, 1)
})

test('tools: policy blocks clear by default, allows new, routes drop selectors', async () => {
  const c = fakeConductor()
  const t = tools(c, DEFAULT_MODEL_POLICY)
  const denied = await t.chat.execute({ action: 'clear' }, exec)
  assert.equal(denied.ok, false)
  assert.match(denied.text, /not allowed the assistant to clear/)
  const reset = await t.chat.execute({ action: 'new', focus: 'x' }, exec)
  assert.equal(reset.ok, true)
  assert.deepEqual(c.calls.find((x) => x[0] === 'reset').slice(1, 2), ['new'])
  await t.chat.execute({ action: 'drop', last: 2, tool: 'read' }, exec)
  const drop = c.calls.find((x) => x[0] === 'drop')
  assert.deepEqual(drop[2], { last: 2, tool: 'read' })
  assert.equal(drop[3].by, 'model')
  const empty = await t.chat.execute({ action: 'drop' }, exec)
  assert.equal(empty.ok, false)
  const noEdit = await tools(c, { edit: false }).chat.execute({ action: 'edit', text: 'x' }, exec)
  assert.equal(noEdit.ok, false)
})

test('tools: chats post is silent and attributed to the calling chat', async () => {
  const c = fakeConductor()
  const t = tools(c)
  const out = await t.chats.execute({ action: 'post', chat: 'Main', text: 'done', kind: 'report' }, exec)
  assert.equal(out.ok, true)
  const post = c.calls.find((x) => x[0] === 'post')
  assert.equal(post[1].fromSessionId, 'session-z')
  assert.equal(post[1].visible, 'user+model')
  assert.equal(post[2].by, 'model')
  const blocked = await tools(c, { post: false }).chats.execute({ action: 'post', chat: 'Main', text: 'x' }, exec)
  assert.equal(blocked.ok, false)
})

test('tools: schemas carry enums and required action', () => {
  const t = tools(fakeConductor())
  assert.equal(t.chat.parameters.action.required, true)
  assert.ok(t.chat.parameters.action.enum.includes('new'))
  assert.ok(t.chats.parameters.action.enum.includes('post'))
  assert.ok(t.tasks.parameters.action.enum.includes('create'))
  assert.ok('command' in t.tasks.parameters, 'task create fields are flattened in')
  for (const d of Object.values(t)) assert.doesNotMatch(d.description, /[\u2013\u2014]/)
})

// ── round 4: recall, handoff template, final answers ────────────────────

import { recall, renderRecall, tokenize, clearRecallCache } from '../lib/conductor/recall.js'
import { DEFAULT_HANDOFF_TEMPLATE } from '../lib/context/engine.js'
import { mkdir, writeFile } from 'node:fs/promises'

test('recall: finds the best passage across archives, drops and handoffs; phrases score higher', () => withTmp(async (dir) => {
  clearRecallCache()
  const archiveDir = join(dir, 'archive')
  const handoffDir = join(dir, 'handoffs')
  await mkdir(join(archiveDir, 'session-r', 'drops'), { recursive: true })
  await mkdir(join(handoffDir, 'session-r'), { recursive: true })
  await writeFile(join(archiveDir, 'session-r', '2026-11-01T10-00-00-000Z.md'), ['# archive', 'noise', 'The deploy key lives in vault X.', 'more noise', ...Array(40).fill('filler'), 'deploy happens on fridays'].join('\n'))
  await writeFile(join(archiveDir, 'session-r', 'drops', '2026-11-02T10-00-00-000Z-5.md'), 'dropped: deploy logs\nkey rotation done')
  await writeFile(join(handoffDir, 'session-r', '2026-11-03T10-00-00-000Z.md'), '# Handoff\n## 5. Files\n- vault X holds the deploy key')
  const result = recall('session-r', 'deploy key vault', { archiveDir, handoffDir, limit: 3 })
  assert.equal(result.searched, 3)
  assert.ok(result.hits.length >= 2)
  assert.match(result.hits[0].snippet, /deploy key/i)
  assert.ok(['archive', 'handoff'].includes(result.hits[0].kind))
  assert.match(renderRecall(result, 'deploy key vault'), /:\d+-\d+/)
  const phrase = recall('session-r', '"fridays"', { archiveDir, handoffDir })
  assert.match(phrase.hits[0].snippet, /fridays/)
  assert.deepEqual(tokenize('"exact one" a bb').phrases, ['exact one'])
  assert.match(renderRecall(recall('session-none', 'deploy key', { archiveDir, handoffDir }), 'deploy key'), /no earlier epochs/)
}))

test('handoff: a custom template replaces the sections, running work is listed', () => {
  const custom = '# Handoff\n## Customers\n- [who]\n## Deploy state\n- [what]'
  const text = handoffInstruction('f', custom, '- subagent session-1 (running)')
  assert.match(text, /## Customers/)
  assert.doesNotMatch(text, /## 7\. Gotchas/)
  assert.match(text, /Work still running right now[\s\S]*session-1/)
  assert.ok(handoffInstruction().includes(DEFAULT_HANDOFF_TEMPLATE))
})

import { parseAutoNew, lastDailyDue, describeAutoNew } from '../lib/conductor/automation.js'

test('automation: schedule grammar and the daily due time in a time zone', () => {
  assert.deepEqual(parseAutoNew(['daily', '3:00']), { daily: '03:00' })
  assert.deepEqual(parseAutoNew(['turns', '40']), { everyTurns: 40 })
  assert.deepEqual(parseAutoNew(['off']), { off: true })
  assert.ok(parseAutoNew(['daily', '25:00']).error)
  assert.ok(parseAutoNew(['turns', '1']).error)
  const now = new Date('2026-11-08T08:30:00Z') // 10:30 in Athens (UTC+2)
  assert.equal(lastDailyDue('03:00', 'Europe/Athens', now).toISOString(), '2026-11-08T01:00:00.000Z')
  assert.equal(lastDailyDue('11:00', 'Europe/Athens', now).toISOString(), '2026-11-07T09:00:00.000Z', 'not yet today: yesterday')
  assert.match(describeAutoNew({ daily: '03:00', tz: 'Europe/Athens', everyTurns: 40 }), /daily at 03:00 \(Europe\/Athens\) and every 40 turns/)
})

import { shadowCompactionConfig, installLevelPatch } from '../lib/context/engine.js'
import { parseLevel } from '../lib/conductor/commands.js'

test('level: shadow config moves the trigger everywhere and keeps the tail below it', () => {
  const base = Object.freeze({ thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [Object.freeze({ provider: 'p', model: 'm', thresholdRatio: 0.7, retainRatio: 0.1 }), Object.freeze({ provider: 'q', model: 'n', retainTokens: 2048 })] })
  const s = shadowCompactionConfig(base, 0.3)
  assert.equal(s.thresholdRatio, 0.3)
  assert.equal(s.retainRatio, 0.1, 'retain lowered to a third of the level')
  assert.equal(s.modelPolicies[0].thresholdRatio, 0.3)
  assert.equal(s.modelPolicies[0].retainRatio, 0.1)
  assert.equal(s.modelPolicies[1].retainTokens, 2048)
  assert.equal(base.thresholdRatio, 0.8, 'the original is untouched')
  assert.equal(shadowCompactionConfig(base, 0.9).retainRatio, 0.16)
})

test('level: the wrapper shadows only the pressure trigger and runs handoff mode when asked', async () => {
  const seen = []
  const proto = { async compactIfNeeded(agent, trigger) { seen.push({ trigger, ratio: this.config.thresholdRatio, forced: state.forced.get(agent.session.id)?.mode }); return { ok: true } } }
  const events = []
  const state = {
    forced: new Map(),
    levelFor: () => ({ ratio: 0.5, action: 'handoff' }),
    handoffOptions: () => ({ pins: [] }),
    measure: () => 1234,
    onAutoHandoff: (info) => events.push(info),
  }
  const remove = installLevelPatch(proto, state)
  const engine = Object.create(proto)
  engine.config = Object.freeze({ thresholdRatio: 0.8, retainRatio: 0.16 })
  await engine.compactIfNeeded({ session: { id: 's1' } }, 'pressure')
  await engine.compactIfNeeded({ session: { id: 's1' } }, 'context-overflow')
  assert.deepEqual(seen[0], { trigger: 'pressure', ratio: 0.5, forced: 'handoff' })
  assert.deepEqual(seen[1], { trigger: 'context-overflow', ratio: 0.8, forced: undefined })
  assert.equal(state.forced.size, 0, 'forced mode cleared')
  remove()
  assert.equal(typeof proto.compactIfNeeded, 'function')
})

test('level: /auto level grammar', () => {
  assert.deepEqual(parseLevel(['50']), { percent: 50 })
  assert.deepEqual(parseLevel(['50%', 'handoff']), { percent: 50, action: 'handoff' })
  assert.deepEqual(parseLevel(['default']), { off: true })
  assert.ok(parseLevel(['5']).error)
  assert.ok(parseLevel(['50', 'explode']).error)
})

import { classifyFailure, backoffMs, lastTurn, unknownOutcomeTools, resolveRecovery, createRecovery } from '../lib/conductor/recovery.js'

test('recovery: failures are classified; permanent ones never retry', () => {
  assert.equal(classifyFailure({ code: 'RATE_LIMIT', status: 429 }).cls, 'rate-limit')
  assert.equal(classifyFailure({ status: 429, message: 'Insufficient balance' }).cls, 'quota')
  assert.equal(classifyFailure({ code: 'QUOTA' }).permanent, true)
  assert.equal(classifyFailure({ status: 401 }).cls, 'auth')
  assert.equal(classifyFailure({ code: 'INVALID_REQUEST', status: 400 }).permanent, true)
  assert.equal(classifyFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }).cls, 'context')
  assert.equal(classifyFailure({ status: 503 }).cls, 'server')
  assert.equal(classifyFailure({ code: 'TIMEOUT' }).cls, 'transport')
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR' }).permanent, false)
  assert.equal(classifyFailure({ code: 'RATE_LIMIT', providerRetryAfterMs: 7000 }).retryAfterMs, 7000)
})

test('recovery: backoff honours Retry-After, grows exponentially and is capped', () => {
  const cfg = resolveRecovery({ baseDelayMs: 1000, maxDelayMs: 10000 })
  assert.equal(backoffMs(1, cfg, 3000), 3250)
  assert.equal(backoffMs(1, cfg, undefined, () => 0.5), 1000)
  assert.equal(backoffMs(3, cfg, undefined, () => 0.5), 4000)
  assert.equal(backoffMs(9, cfg, undefined, () => 0.5), 10000)
  assert.equal(resolveRecovery({ maxAttempts: 999 }).maxAttempts, 20)
})

function turnEvents(reason, extra = []) {
  const ev = []
  const push = (type, data = {}) => ev.push({ type, seq: ev.length, time: Date.now(), data })
  push('turn/start')
  push('user/message', { id: 'u', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })
  for (const [type, data] of extra) push(type, data)
  push('turn/end', { reason })
  return ev
}

function recoveryWith(events, cfgOverrides = {}, status = 'idle') {
  const st = { activity: [] }
  const conductor = {
    store: { get: () => st, update: (_id, fn) => fn(st), activity: () => {} },
    post: async () => ({ ok: true }),
    reset: async () => ({ ok: true }),
    agentFor: async () => agent,
  }
  const agent = { status, session: { id: 'session-rec', snapshotEvents: () => events }, followup: () => {} }
  const rec = createRecovery({ agents: { get: () => agent } }, conductor, { cfg: () => ({ recovery: cfgOverrides }), detectContinue: () => false })
  return { rec, agent, st }
}

test('recovery: decisions for each way a turn can end', () => {
  const failed = (failure) => recoveryWith(turnEvents({ kind: 'error', error: failure }))
  let r = failed({ code: 'RATE_LIMIT', status: 429 })
  let d = r.rec.decide(r.agent)
  assert.equal(d.action, 'resume')
  assert.match(d.text, /failed because of a rate limit/)
  r = failed({ code: 'QUOTA' })
  assert.equal(r.rec.decide(r.agent).action, 'stop')
  r = failed({ code: 'CONTEXT_WINDOW_EXCEEDED' })
  assert.equal(r.rec.decide(r.agent).handoff, true)
  r = recoveryWith(turnEvents({ kind: 'completed' }))
  assert.equal(r.rec.decide(r.agent).action, 'success')
  r = recoveryWith(turnEvents({ kind: 'aborted' }))
  assert.equal(r.rec.decide(r.agent).action, 'reset')
  r = recoveryWith(turnEvents({ kind: 'max-tokens' }, [['assistant/message', { message: { content: [{ type: 'text', text: 'half an ans' }] } }]]))
  assert.match(r.rec.decide(r.agent).text, /cut off at the output limit/)
  r = recoveryWith(turnEvents({ kind: 'max-tokens' }, [['assistant/message', { message: { content: [{ type: 'tool-call', id: 'c', name: 'read' }] } }]]))
  assert.equal(r.rec.decide(r.agent).action, 'none', 'max-tokens with a tool call is not a cut-off answer')
  r = recoveryWith(turnEvents({ kind: 'interrupted' }, [['assistant/message', { message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash' }] } }], ['tool/result', { message: { toolCallId: 'c1' }, error: { code: 'TOOL_OUTCOME_UNKNOWN' } }]]))
  d = r.rec.decide(r.agent)
  assert.equal(d.action, 'resume')
  assert.match(d.text, /may or may not have run: bash/)
  r = failed({ code: 'RATE_LIMIT' })
  r.st.recovery = { attempts: 5 }
  assert.equal(r.rec.decide(r.agent).action, 'stop', 'attempt cap')
  r = failed({ code: 'RATE_LIMIT' })
  r.st.recovery = { disabled: true }
  assert.equal(r.rec.decide(r.agent).action, 'none', 'off for this chat')
  r = recoveryWith(turnEvents({ kind: 'error', error: { status: 503 } }), { fallbackModel: 'backup-1', fallbackAfter: 2 })
  r.st.recovery = { attempts: 1 }
  assert.equal(r.rec.decide(r.agent).fallback?.model, 'backup-1')
})

test('recovery: fallback model applies to this chat only and switches back after a good turn', async () => {
  const r = recoveryWith(turnEvents({ kind: 'completed' }))
  r.st.recovery = { fallback: { model: 'backup-1' } }
  const payload = { agent: r.agent }
  const cfg1 = await r.rec.requestHook(payload, async () => ({ provider: 'main', model: 'big-1', maxTokens: 10 }))
  assert.deepEqual(cfg1, { provider: 'main', model: 'backup-1', maxTokens: 10 })
  await r.rec.onIdle(r.agent) // completed turn on the fallback
  const cfg2 = await r.rec.requestHook(payload, async () => ({ provider: 'main', model: 'backup-1' }))
  assert.deepEqual(cfg2, { provider: 'main', model: 'big-1' })
  const cfg3 = await r.rec.requestHook(payload, async () => ({ provider: 'main', model: 'big-1' }))
  assert.deepEqual(cfg3, { provider: 'main', model: 'big-1' })
})

test('recovery: lastTurn and unknown outcome helpers', () => {
  assert.equal(lastTurn([{ type: 'turn/start', seq: 0 }]), null, 'open turn')
  const ev = turnEvents({ kind: 'completed' })
  assert.equal(lastTurn(ev).endSeq, ev.length - 1)
  assert.deepEqual(unknownOutcomeTools([{ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'a', name: 'write' }, { type: 'tool-call', id: 'b', name: 'read' }] } } }, { type: 'tool/result', data: { message: { toolCallId: 'b' } } }]), ['write'])
})

import { createCheckpoints } from '../lib/conductor/checkpoints.js'
import { readFile as readFileP, writeFile as writeFileP, rm as rmP } from 'node:fs/promises'

test('checkpoints: per-turn checkpoints, file pre-images, restore with conflicts, undo', () => withTmp(async (dir) => {
  const store = new SessionStore(join(dir, 'sessions'), { debounceMs: 5 })
  const session = { id: 'session-cp', header: { delegationDepth: 0 }, snapshotEvents: () => [] }
  const conductor = { store, ConductorError: Error, agentFor: async () => ({ status: 'idle', session }), engineState: { cfg: { archiveDir: join(dir, 'arch') } } }
  const cps = createCheckpoints({ get: () => null }, conductor, { stateDir: dir })
  const work = join(dir, 'work')
  await mkdir(work)
  const a = join(work, 'a.txt')
  const b = join(work, 'b.txt')
  await writeFileP(a, 'A1')
  const exec = {}
  cps._execSession.set(exec, session)
  const turn = (seq, label, edits) => {
    cps.onSessionEvent(session, { type: 'turn/start', seq, time: Date.now(), data: { turn: seq } })
    cps.onSessionEvent(session, { type: 'user/message', seq: seq + 1, data: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text: label }], source: { kind: 'user' } } })
    return (async () => {
      for (const [path, content] of edits) {
        cps.capture({ path }, exec)
        await writeFileP(path, content)
      }
      cps.onSessionEvent(session, { type: 'turn/end', seq: seq + 9, data: { reason: { kind: 'completed' } } })
    })()
  }
  await turn(10, 'first prompt', [[a, 'A2']])
  await turn(20, 'second prompt', [[a, 'A3'], [b, 'B1']])
  const list = cps.list('session-cp')
  assert.equal(list.length, 2)
  assert.equal(list[0].label, 'second prompt')
  assert.equal(list[0].files, 2)
  // rewind files to before the second prompt: a back to A2, b deleted
  let r = await cps.rewind('session-cp', '1', { chat: false })
  assert.deepEqual(r.files.done.sort(), [a, b].sort())
  assert.equal(await readFileP(a, 'utf8'), 'A2')
  assert.equal(existsSync(b), false)
  // undo puts A3 and B1 back
  assert.equal(cps.undoRestore('session-cp').ok, true)
  assert.equal(await readFileP(a, 'utf8'), 'A3')
  assert.equal(await readFileP(b, 'utf8'), 'B1')
  // a file changed outside the agent is a conflict unless forced
  await writeFileP(a, 'edited by hand')
  r = await cps.rewind('session-cp', '2', { chat: false })
  assert.deepEqual(r.files.conflicts, [a])
  assert.equal(await readFileP(a, 'utf8'), 'edited by hand')
  r = await cps.rewind('session-cp', '2', { chat: false, force: true })
  assert.ok(r.files.done.includes(a))
  assert.equal(await readFileP(a, 'utf8'), 'A1')
  assert.match(r.text, /shell commands are not tracked/)
  // manual checkpoint by name needs a loaded agent: covered end to end
  store.flush()
}))

test('store: every feature key survives a restart (checkpoints, automation, relay, template, recovery, unknown keys)', () => withTmp(async (dir) => {
  const a = new SessionStore(dir, { debounceMs: 5 })
  a.update('session-keep', (s) => {
    s.checkpoints = [{ id: 'cp-1', boundarySeq: 3 }]
    s.autoCompact = { percent: 50, action: 'handoff', paused: true }
    s.autoNew = { daily: '03:00', tz: 'Europe/Athens' }
    s.relay = { to: 'session-main', label: 'Main' }
    s.handoffTemplate = '# Handoff\n## Customers'
    s.recovery = { disabled: true }
    s.nudgedAt = '2026-11-08T10:00:00Z'
    s.futureFeature = { kept: true }
  })
  a.flush()
  const b = new SessionStore(dir)
  const s = b.get('session-keep')
  assert.deepEqual(s.checkpoints, [{ id: 'cp-1', boundarySeq: 3 }])
  assert.equal(s.autoCompact.percent, 50)
  assert.equal(s.autoCompact.paused, true)
  assert.equal(s.autoNew.daily, '03:00')
  assert.equal(s.relay.to, 'session-main')
  assert.equal(s.handoffTemplate, '# Handoff\n## Customers')
  assert.equal(s.recovery.disabled, true)
  assert.equal(s.nudgedAt, '2026-11-08T10:00:00Z')
  assert.deepEqual(s.futureFeature, { kept: true })
  b.update('session-keep', (x) => { x.pins.push({ id: 'p' }) })
  b.flush()
  assert.equal(new SessionStore(dir).get('session-keep').relay.label, 'Main', 'a later write keeps them too')
}))
