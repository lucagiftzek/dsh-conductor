/**
 * dsh-conductor - the agent-facing tool surface.
 *
 * Tools the MODEL gets (namespaced orch_*, short and grep-able):
 *
 *   orch_status         one-screen overview: agents, tasks, runners, providers
 *   orch_agents_list    live + cold chats, with titles and running flags
 *   orch_agent_status   one chat: running state + last user/assistant text
 *   orch_agent_prompt   send a message into a chat (id, prefix or title);
 *                       cold chats resume through the session controller
 *   orch_agent_spawn    create new chat(s) - blank or with a first prompt,
 *                       with fan-out (count) and {i} interpolation
 *   orch_agent_fork     split an existing chat into a new session at a turn
 *   orch_agent_cancel   cancel a chat's active turn
 *   orch_task_create    run a task: command | scrape | http | agent
 *   orch_task_list      list tasks (filters: status, type)
 *   orch_task_status    one task: status, detail, output preview
 *   orch_task_output    full/tail output of a task
 *   orch_task_cancel    cancel a task
 *   orch_runners        runner inventory + health probes
 *   orch_providers      provider status cards (e.g. the HPC grant)
 *
 * Every mutating tool routes through the same engine the sidebar uses -
 * there is exactly one code path for each action, one audit log, one
 * settings surface. Tools never bypass the engine's validation.
 */

'use strict'

import { losslessDefineTool } from './lossless.js'

const TEXT = (s) => [{ type: 'text', text: String(s) }]
const MAX_ROWS = 60

function truncate(s, n) {
  const t = String(s === undefined || s === null ? '' : s)
  return t.length > n ? t.slice(0, n) + '...' : t
}

function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 90) return s + 's ago'
  if (s < 5400) return Math.round(s / 60) + 'm ago'
  if (s < 172800) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86400) + 'd ago'
}

function shortId(id) {
  const s = String(id || '')
  return s.length > 18 ? s.slice(0, 12) + '...' + s.slice(-4) : s
}

/**
 * Build every tool definition. deps: {engine, agents, providers, runners,
 * cfg, probeRunners}. Exported so tests compile them against fakes without
 * mounting anything.
 */
export function agentTools(rawDefineTool, deps) {
  // DSH 0.2.1 rejects tool results that are not lossless JSON (undefined, NaN, Date, ...): sanitize at the boundary.
  const defineTool = losslessDefineTool(rawDefineTool)
  const { engine, agents, providers, cfg } = deps
  const probeRunners = deps.probeRunners
  const defs = []

  defs.push(defineTool({
    name: 'orch_status',
    description: 'One-screen orchestration overview: how many chats are live/running, task counts by status, runner inventory and provider health (e.g. the HPC grant card). Call this first when you are unsure what exists.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          agents: { type: 'json', required: true },
          tasks: { type: 'json', required: true },
          runners: { type: 'json', required: true },
          providers: { type: 'json', required: true },
        },
      },
      render: (_a, v) => TEXT(renderStatus(v)),
    },
    async execute() {
      const cat = await agents.catalog()
      const rows = engine.list({ limit: 500 })
      const byStatus = {}
      for (const t of rows) byStatus[t.status] = (byStatus[t.status] || 0) + 1
      const provs = await providers.statusAll({ background: true }).catch(() => [])
      return {
        ok: true,
        agents: {
          total: cat.rows.length,
          live: cat.rows.filter((r) => r.live).length,
          running: cat.rows.filter((r) => r.running).length,
        },
        tasks: byStatus,
        runners: cfg.runners.map((r) => ({ id: r.id, kind: r.kind, enabled: r.enabled !== false })),
        providers: provs.map((p) => ({ id: p.id, kind: p.kind, ok: p.ok, detail: p.detail })),
      }
    },
  }))

  defs.push(defineTool({
    name: 'orch_agents_list',
    description: 'List chats/agents: live and cold, with titles, running flags and recency. Filter with live=true for only mounted agents, or search by title substring. Subagent children are marked.',
    parameters: {
      live: { type: 'boolean', description: 'Only live (mounted) agents.' },
      search: { type: 'string', description: 'Case-insensitive title substring filter.' },
      limit: { type: 'integer', description: 'Max rows (default 40, max 120).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          rows: { type: 'json', required: true },
          total: { type: 'integer', required: true },
        },
      },
      render: (_a, v) => TEXT(v.rows.length
        ? v.rows.map((r) => [
          r.running ? 'RUN' : r.live ? 'live' : 'cold',
          shortId(r.sessionId),
          r.origin === 'subagent' ? '(subagent)' : '',
          truncate(r.title || '(untitled)', 60),
          r.updatedAt ? fmtAgo(r.updatedAt) : '',
        ].filter(Boolean).join('  ')).join('\n')
        : 'no chats match'),
    },
    async execute(args) {
      const cat = await agents.catalog()
      let rows = cat.rows
      if (args && args.live === true) rows = rows.filter((r) => r.live)
      if (args && typeof args.search === 'string' && args.search.trim()) {
        const q = args.search.trim().toLowerCase()
        rows = rows.filter((r) => (r.title || '').toLowerCase().includes(q) || (r.sessionId || '').toLowerCase().includes(q))
      }
      const limit = Math.min(120, Math.max(1, Number(args && args.limit) || 40))
      return { ok: true, total: rows.length, rows: rows.slice(0, limit) }
    },
  }))

  defs.push(defineTool({
    name: 'orch_agent_status',
    description: 'Status of one chat: running state, title, last user prompt and last assistant answer (truncated). Accepts an id, a unique id prefix, or an exact title.',
    parameters: {
      agent: { type: 'string', description: 'Session id, unique id prefix, or exact title.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok
        ? [v.status.title || shortId(v.status.sessionId),
          'state: ' + v.status.status + (v.status.running ? ' (working now)' : ''),
          v.status.lastUser ? 'last user: ' + truncate(v.status.lastUser, 200) : '',
          v.status.lastAssistant ? 'last assistant: ' + truncate(v.status.lastAssistant, 600) : '',
        ].filter(Boolean).join('\n')
        : 'error: ' + v.error),
    },
    async execute(args) {
      const ref = await agents.resolveRef(args && args.agent)
      if (ref.kind === 'invalid' || ref.kind === 'unknown') return { ok: false, error: ref.reason || 'not found' }
      if (ref.kind === 'ambiguous') return { ok: false, error: 'ambiguous reference: ' + ref.ids.join(', ') }
      const st = await agents.status(ref.id)
      return { ok: true, status: st }
    },
  }))

  defs.push(defineTool({
    name: 'orch_agent_prompt',
    description: 'Send a message into a chat (queues it; a cold chat is resumed by the session controller). Accepts an id, a unique id prefix, or an exact title. Returns once the message is accepted - it does NOT wait for the answer; poll orch_agent_status.',
    parameters: {
      agent: { type: 'string', description: 'Session id, unique id prefix, or exact title.' },
      message: { type: 'string', description: 'The text to deliver (markdown ok).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sessionId: { type: 'string' },
          via: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok
        ? 'message accepted by ' + shortId(v.sessionId) + ' (via ' + v.via + ') - poll orch_agent_status for the answer'
        : 'error: ' + v.error),
    },
    async execute(args) {
      const ref = await agents.resolveRef(args && args.agent)
      if (ref.kind === 'invalid' || ref.kind === 'unknown') return { ok: false, error: ref.reason || 'not found' }
      if (ref.kind === 'ambiguous') return { ok: false, error: 'ambiguous reference: ' + ref.ids.join(', ') }
      const r = await agents.prompt({ sessionId: ref.id, text: args && args.message })
      return r.ok ? { ok: true, sessionId: ref.id, via: r.via } : { ok: false, error: r.error }
    },
  }))

  defs.push(defineTool({
    name: 'orch_agent_spawn',
    description: 'Create new chat(s) and optionally deliver a first prompt immediately. count>1 fans out parallel chats; {i} in title/prompt is replaced with the 1-based index. This is how you SPLIT work across agents.',
    parameters: {
      prompt: { type: 'string', description: 'First message to deliver (optional if you only want the session).' },
      title: { type: 'string', description: 'Session title (renames the chat so it is addressable by name).' },
      count: { type: 'integer', description: 'How many parallel chats (1-8, default 1).' },
      preset: { type: 'string', description: 'Agent preset id (optional; deployment default otherwise).' },
      cwd: { type: 'string', description: 'Working directory for the new chat (optional).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          created: { type: 'json' },
          prompted: { type: 'integer' },
          failures: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok
        ? 'spawned ' + v.created.length + ' chat(s): ' + v.created.map((c) => shortId(c.sessionId)).join(', ')
          + (v.prompted ? ' - first prompt delivered to ' + v.prompted : '')
        : 'error: ' + v.error),
    },
    async execute(args) {
      const r = await agents.spawn({
        title: args && args.title,
        prompt: args && args.prompt,
        preset: args && args.preset,
        cwd: args && args.cwd,
        count: args && args.count,
      })
      return r.ok ? r : { ok: false, error: (r.failures && r.failures[0]) || 'spawn failed' }
    },
  }))

  defs.push(defineTool({
    name: 'orch_agent_fork',
    description: 'SPLIT an existing chat: fork it into a NEW session carrying the completed-turn history, then optionally deliver a new prompt to the fork. Use it to branch a conversation without touching the original.',
    parameters: {
      agent: { type: 'string', description: 'Source session id, prefix, or title.' },
      prompt: { type: 'string', description: 'First message for the fork (optional).' },
      title: { type: 'string', description: 'Title for the fork (optional).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sessionId: { type: 'string' },
          prompted: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok
        ? 'forked into ' + shortId(v.sessionId) + (v.prompted ? ' and prompted' : '')
        : 'error: ' + v.error),
    },
    async execute(args) {
      const ref = await agents.resolveRef(args && args.agent)
      if (ref.kind === 'invalid' || ref.kind === 'unknown') return { ok: false, error: ref.reason || 'not found' }
      if (ref.kind === 'ambiguous') return { ok: false, error: 'ambiguous reference: ' + ref.ids.join(', ') }
      const f = await agents.fork(ref.id, {
        title: args && typeof args.title === 'string' ? args.title : undefined,
        prompt: args && typeof args.prompt === 'string' ? args.prompt : undefined,
      })
      if (!f.ok) return { ok: false, error: f.error }
      const prompted = Boolean(f.prompted)
      return { ok: true, sessionId: f.sessionId, prompted }
    },
  }))

  defs.push(defineTool({
    name: 'orch_agent_cancel',
    description: 'Cancel the active turn of one chat (pending inbox work is kept). Accepts an id, a unique id prefix, or an exact title.',
    parameters: {
      agent: { type: 'string', description: 'Session id, unique id prefix, or exact title.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sessionId: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok ? 'cancel requested on ' + shortId(v.sessionId) : 'error: ' + v.error),
    },
    async execute(args) {
      const ref = await agents.resolveRef(args && args.agent)
      if (ref.kind === 'invalid' || ref.kind === 'unknown') return { ok: false, error: ref.reason || 'not found' }
      if (ref.kind === 'ambiguous') return { ok: false, error: 'ambiguous reference: ' + ref.ids.join(', ') }
      const r = await agents.cancel(ref.id)
      return r.ok ? { ok: true, sessionId: ref.id } : { ok: false, error: r.error }
    },
  }))

  defs.push(defineTool({
    name: 'orch_task_create',
    description: 'Create and run a tracked task. Types: "command" (shell on a runner: local, ssh, or an http tool server), "scrape" (deterministic multi-URL fetch + text/html/attr/regex extraction, NO model in the loop), "http" (call an endpoint, record status+body), "agent" (spawn/prompt a chat and track it chat-style). Returns the task id immediately - poll orch_task_status / orch_task_output.',
    parameters: {
      type: { type: 'string', description: 'command | scrape | http | agent.' },
      title: { type: 'string', description: 'Human label for the task list.' },
      runner: { type: 'string', description: 'Runner id (command/http tasks). "auto" uses the configured default.' },
      command: { type: 'string', description: 'command: the shell command to run.' },
      cwd: { type: 'string', description: 'command/agent: working directory.' },
      timeoutMs: { type: 'integer', description: 'Per-task timeout override (ms).' },
      urls: { type: 'array', items: { type: 'string' }, description: 'scrape: http(s) url list.' },
      url: { type: 'string', description: 'scrape/http: single url.' },
      extract: { type: 'string', description: 'scrape: text | html | json.' },
      selector: { type: 'string', description: 'scrape: simple selector (tag, .class, #id, [attr]).' },
      attribute: { type: 'string', description: 'scrape: attribute to read off the matched element.' },
      pattern: { type: 'string', description: 'scrape: regex applied to the extracted text; match groups if present.' },
      method: { type: 'string', description: 'http: HTTP method (default GET).' },
      body: { type: 'string', description: 'http: request body.' },
      headers: { type: 'object', additionalProperties: true, description: 'http: extra request headers (json object of strings).' },
      expectStatus: { type: 'integer', description: 'http: expected status code (else 2xx).' },
      prompt: { type: 'string', description: 'agent: the prompt to deliver.' },
      count: { type: 'integer', description: 'agent: fan-out count (1-8).' },
      preset: { type: 'string', description: 'agent: preset for the new chat.' },
      forkOf: { type: 'string', description: 'agent: fork this existing chat instead of spawning fresh.' },
      promptExisting: { type: 'string', description: 'agent: deliver the prompt to this existing chat instead of spawning.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          task: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok
        ? 'task ' + v.task.id + ' (' + v.task.type + ', ' + v.task.status + ') started: ' + v.task.title
        : 'error: ' + v.error),
    },
    async execute(args, exec) {
      // exec.agent is the session on whose behalf the tool runs - stamp it as
      // the task owner so 'this chat' views (tab + orch_task_list owner filter)
      // can scope to it.
      const ownerSession = exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : undefined
      const r = await engine.create(args || {}, { ownerSession })
      return r.ok ? { ok: true, task: publicOf(r.task) } : { ok: false, error: r.error }
    },
  }))

  defs.push(defineTool({
    name: 'orch_task_list',
    description: 'List tasks, newest first. Filter by status (queued|running|completed|failed|cancelled|interrupted), type (command/scrape/http/agent), and/or owner (a session id - pass your own id to see only tasks created by or driving this chat).',
    parameters: {
      status: { type: 'string', description: 'Status filter.' },
      type: { type: 'string', description: 'Type filter.' },
      owner: { type: 'string', description: 'Session id: only tasks created by that session or driving one of its agents.' },
      limit: { type: 'integer', description: 'Max rows (default 30, max 200).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          rows: { type: 'json', required: true },
        },
      },
      render: (_a, v) => TEXT(v.rows.length
        ? v.rows.map((t) => [t.status.toUpperCase().slice(0, 9), t.id, t.type, truncate(t.title, 50), t.detail ? truncate(t.detail, 60) : ''].filter(Boolean).join('  ')).join('\n')
        : 'no tasks match'),
    },
    async execute(args) {
      const rows = engine.list({
        status: args && args.status,
        type: args && args.type,
        owner: args && args.owner,
        limit: Math.min(200, Math.max(1, Number(args && args.limit) || 30)),
      })
      return { ok: true, rows }
    },
  }))

  defs.push(defineTool({
    name: 'orch_task_status',
    description: 'One task: status, detail, timing, runner and output preview. For the full output use orch_task_output.',
    parameters: {
      taskId: { type: 'string', description: 'The task id from orch_task_create.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          task: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok
        ? [v.task.id + ' ' + v.task.status,
          v.task.detail ? 'detail: ' + v.task.detail : '',
          v.task.agentSessionId ? 'chat: ' + shortId(v.task.agentSessionId) : '',
          v.task.outputPreview ? 'output: ' + truncate(v.task.outputPreview, 500) : '',
        ].filter(Boolean).join('\n')
        : 'error: ' + v.error),
    },
    async execute(args) {
      const t = engine.get(args && args.taskId)
      return t ? { ok: true, task: t } : { ok: false, error: 'no such task' }
    },
  }))

  defs.push(defineTool({
    name: 'orch_task_output',
    description: 'Full (or tail) output of a task: command stdout/stderr, scrape JSON, http body, or the agent answer. tail limits to the last N characters.',
    parameters: {
      taskId: { type: 'string', description: 'The task id.' },
      tail: { type: 'integer', description: 'Only the last N characters (default 8000).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          taskId: { type: 'string' },
          status: { type: 'string' },
          output: { type: 'string', required: true },
          truncated: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok ? truncate(v.output, 4000) : 'error: ' + v.error),
    },
    async execute(args) {
      const r = engine.output(args && args.taskId, { tail: args && Number(args.tail) || 8000 })
      return r
    },
  }))

  defs.push(defineTool({
    name: 'orch_task_cancel',
    description: 'Cancel a queued/running task. Command tasks are killed; agent tasks also cancel the chat active turn.',
    parameters: {
      taskId: { type: 'string', description: 'The task id.' },
      reason: { type: 'string', description: 'Short reason, recorded in the audit log.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => TEXT(v.ok ? 'cancelled' : 'error: ' + v.error),
    },
    async execute(args) {
      return engine.cancel(args && args.taskId, (args && args.reason) || 'agent')
    },
  }))

  defs.push(defineTool({
    name: 'orch_runners',
    description: 'Runner inventory: id, kind (local/ssh/http), enabled state - and live health probes when probe=true. Runners are where command tasks execute; they are declared in Settings, never in code.',
    parameters: {
      probe: { type: 'boolean', description: 'Also run a health probe on each runner (default true).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          rows: { type: 'json', required: true },
        },
      },
      render: (_a, v) => TEXT(v.rows.map((r) => [
        r.kind,
        r.id,
        r.enabled ? '' : ' (disabled)',
        r.probe ? (r.probe.ok ? 'reachable ' + r.probe.ms + 'ms' : 'UNREACHABLE: ' + truncate(r.probe.detail, 80)) : '',
      ].filter(Boolean).join('  ')).join('\n')),
    },
    async execute(args) {
      const rows = []
      for (const r of cfg.runners) {
        const row = { id: r.id, kind: r.kind, label: r.label, enabled: r.enabled !== false }
        if ((args ? args.probe !== false : true) && probeRunners) {
          row.probe = await probeRunners(r)
        }
        rows.push(row)
      }
      return { ok: true, rows }
    },
  }))

  defs.push(defineTool({
    name: 'orch_providers',
    description: 'Provider status cards: integrations declared in Settings (kind hpc reads a dsh-hpc route; kind http reads any JSON status endpoint). Includes the HPC grant headline, queue and staged proposals when an hpc provider is configured.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          rows: { type: 'json', required: true },
        },
      },
      render: (_a, v) => TEXT(v.rows.length
        ? v.rows.map((p) => [
          p.kind,
          p.id,
          p.ok ? 'ok' : 'DOWN',
          p.headline ? truncate(p.headline, 120) : truncate(p.detail, 120),
        ].filter(Boolean).join('  ')).join('\n')
        : 'no providers configured (Settings -> Orchestrator -> providers)'),
    },
    async execute() {
      const rows = await providers.statusAll({}).catch(() => [])
      return { ok: true, rows }
    },
  }))

  return defs
}

function publicOf(task) {
  return {
    id: task.id,
    type: task.type,
    title: task.title,
    status: task.status,
    runner: task.runner,
    detail: task.detail,
    agentSessionId: task.agentSessionId || null,
  }
}

function renderStatus(v) {
  const lines = []
  lines.push('agents: ' + v.agents.total + ' total, ' + v.agents.live + ' live, ' + v.agents.running + ' running')
  const taskBits = Object.entries(v.tasks || {}).map(([k, n]) => n + ' ' + k)
  lines.push('tasks: ' + (taskBits.join(', ') || 'none'))
  lines.push('runners: ' + v.runners.map((r) => r.id + '(' + r.kind + (r.enabled ? '' : ', off') + ')').join(', '))
  if (v.providers.length) {
    lines.push('providers: ' + v.providers.map((p) => p.id + '(' + (p.ok ? 'ok' : 'down') + ')').join(', '))
  } else {
    lines.push('providers: none configured')
  }
  return lines.join('\n')
}

export const __tools = { truncate, fmtAgo, shortId, MAX_ROWS }
