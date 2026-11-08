/**
 * Regression: every orch_* tool result (success and error paths) must be lossless JSON by the
 * DSH 0.2.1 rule ("tool returned invalid output: value is not lossless JSON").
 * Run: node test/lossless.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertLossless } from './lossless-check.mjs'
import { resolveConfig } from '../lib/core.js'
import { TaskStore } from '../lib/store.js'
import { TaskEngine } from '../lib/tasks.js'
import { makeAgents } from '../lib/agents.js'
import { Providers } from '../lib/providers.js'
import { agentTools } from '../lib/tools.js'

const defineTool = (def) => def

function ctxWith({ fail = false } = {}) {
  const rows = [
    { sessionId: 'session-aaaaaaaa-1111', title: 'Root chat', origin: 'chat', updatedAt: 5 },
    { sessionId: 'session-bbbbbbbb-2222', title: 'Child', origin: 'subagent', parentSessionId: 'session-aaaaaaaa-1111', updatedAt: 4 },
    { sessionId: 'session-cccccccc-3333', title: '', origin: 'chat' },
  ]
  const live = new Map([['session-aaaaaaaa-1111', { id: 'session-aaaaaaaa-1111', status: 'running', followup() {}, cancel() {}, session: { header: {} } }]])
  const bad = (m) => async () => { throw new Error(m) }
  const controller = {
    list: fail ? bad('controller down') : async () => ({ items: rows }),
    create: fail ? bad('create failed') : async () => ({ sessionId: 'session-new-4444', agentPreset: undefined }),
    fork: fail ? bad('fork failed') : async () => ({ sessionId: 'session-fork-5555' }),
    prompt: fail ? bad('NotFoundError') : async () => ({}),
    cancel: fail ? bad('cancel failed') : async () => ({}),
    rename: async () => ({}),
  }
  return { agents: { list: () => [...live.values()], get: (id) => live.get(id) }, get: (n) => (n === 'sessionController' ? controller : n === 'sessionQuery' ? { listSessions: async () => [], readTitleSnapshots: async () => [] } : undefined) }
}

async function build(dir, { fail = false, noController = false } = {}) {
  const cfg = resolveConfig({ stateDir: dir, tasks: { maxConcurrent: 1, commandTimeoutMs: 2000, pollMs: 50 } })
  const ctx = noController ? { agents: { list: () => [], get: () => undefined }, get: () => undefined } : ctxWith({ fail })
  const agents = makeAgents(ctx, cfg)
  const engine = new TaskEngine(cfg, new TaskStore(dir), agents, { now: () => Date.now() })
  engine.runners = () => [{ id: 'fake', kind: 'local', enabled: true }]
  engine.runWorkTask = async (task) => {
    task.output = 'out'
    task.result = { status: 'completed', detail: '', via: 'fake' }
    engine.settle(task, 'completed')
  }
  await engine.boot()
  const providers = new Providers(cfg)
  const defs = agentTools(defineTool, { engine, agents, providers, cfg, probeRunners: async (r) => ({ ok: r.kind === 'local', ms: undefined, error: undefined }) })
  return { defs, engine }
}

const ARGS = {
  orch_status: [{}],
  orch_agents_list: [{}, { live: true }, { search: 'child' }, { limit: 1 }, { search: 'zzz' }],
  orch_agent_status: [{ agent: 'session-aaaaaaaa-1111' }, { agent: 'session-bbbbbbbb-2222' }, { agent: 'Child' }, { agent: 'nope' }, { agent: '' }, {}, { agent: 'session-' }],
  orch_agent_prompt: [{ agent: 'session-aaaaaaaa-1111', message: 'hi' }, { agent: 'session-bbbbbbbb-2222', message: 'hi' }, { agent: 'nope', message: 'x' }, { agent: 'session-cccccccc-3333', message: '' }],
  orch_agent_spawn: [{ prompt: 'go', title: 't {i}', count: 2 }, {}, { cwd: '/tmp', preset: 'x' }],
  orch_agent_fork: [{ agent: 'session-aaaaaaaa-1111', title: 'f', prompt: 'p' }, { agent: 'session-aaaaaaaa-1111' }, { agent: 'nope' }],
  orch_agent_cancel: [{ agent: 'session-aaaaaaaa-1111' }, { agent: 'session-bbbbbbbb-2222' }, { agent: 'nope' }],
  orch_task_create: [{ type: 'command', command: 'echo hi', title: 'a' }, { type: 'bogus' }, {}, { type: 'http', url: 'ftp://x' }, { type: 'scrape', urls: [] }, { type: 'agent', prompt: 'hi' }],
  orch_task_list: [{}, { status: 'completed' }, { type: 'command', limit: 3 }, { owner: 'session-x' }],
  orch_task_status: [{ taskId: 'nope' }, {}],
  orch_task_output: [{ taskId: 'nope' }, {}],
  orch_task_cancel: [{ taskId: 'nope' }, {}],
  orch_runners: [{}, { probe: false }],
  orch_providers: [{}],
}

async function sweep(dir, opts) {
  const { defs, engine } = await build(dir, opts)
  const names = defs.map((d) => d.name).sort()
  assert.deepEqual(names, Object.keys(ARGS).sort(), 'every tool is covered by the lossless test')
  const created = []
  for (const d of defs) for (const args of ARGS[d.name]) {
    const out = await d.execute(args, { agent: { id: 'session-owner-9999' } })
    await assertLossless(out, `${d.name}(${JSON.stringify(args)})`)
    if (d.name === 'orch_task_create' && out && out.ok) created.push(out.task.id)
  }
  // follow-up reads on real task ids, including a cancel of a settled task
  for (const id of created) {
    await Promise.race([engine.waitSettled(id), new Promise((r) => setTimeout(r, 300))]).catch(() => {})
    for (const n of ['orch_task_status', 'orch_task_output', 'orch_task_cancel']) {
      const d = defs.find((x) => x.name === n)
      await assertLossless(await d.execute({ taskId: id, tail: 5 }), `${n}(${id})`)
    }
  }
  // the render projection must also be lossless (core snapshots render() output)
  for (const d of defs) {
    const v = await d.execute(ARGS[d.name][0], {})
    try { await assertLossless(d.output.render({}, v), `${d.name}.render`) } catch (e) { if (/not lossless/.test(e.message)) throw e }
  }
}

for (const [label, opts] of [['healthy controller', {}], ['failing controller', { fail: true }], ['no controller', { noController: true }]]) {
  test(`lossless tool results: ${label}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-lossless-'))
    try { await sweep(dir, opts) } finally { await rm(dir, { recursive: true, force: true }) }
  })
}
