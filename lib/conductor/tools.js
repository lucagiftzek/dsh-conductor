/**
 * The model tools: three instead of sixteen, because every tool schema is
 * paid on every request of every chat that mounts it.
 *
 *   chat    this chat: context, drop, undrop, pin, unpin, pins, edit,
 *           versions, new, compact, clear, inbox, mark_read
 *   chats   other chats: list, status, prompt (wakes), post (silent),
 *           spawn, fork, cancel
 *   tasks   background work: overview, create, list, status, output,
 *           cancel, runners, providers
 *
 * `chats` and `tasks` delegate to the orchestration code (the same functions
 * the legacy orch_* tools run), so behaviour and validation are identical.
 */
import { losslessDefineTool } from '../lossless.js'
import { agentTools } from '../tools.js'
import { fmtTokens } from './service.js'
import { contextSummary } from './commands.js'

const TEXT = (s) => [{ type: 'text', text: String(s) }]
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    text: { type: 'string', required: true },
    data: { type: 'json' },
  },
}

export const DEFAULT_MODEL_POLICY = Object.freeze({
  drop: true, edit: true, pin: true, new: true, compact: true, clear: false, post: true, prompt: true, spawn: true, cancel: true,
})

const renderBlocks = (blocks) => (Array.isArray(blocks) ? blocks.map((b) => (b?.type === 'text' ? b.text : '')).join('\n') : String(blocks ?? ''))

function policyAllows(policy, action) {
  const value = policy?.[action]
  return value === undefined ? DEFAULT_MODEL_POLICY[action] !== false : value !== false
}

/**
 * @param rawDefineTool the host defineTool
 * @param deps { conductor, engine, agents, providers, cfg (proxy), probeRunners, policy: () => object }
 * @param options { tools: { chat, chats, tasks, legacy } }
 * @returns tool definitions
 */
export function conductorTools(rawDefineTool, deps, options = {}) {
  const defineTool = losslessDefineTool(rawDefineTool)
  const { conductor } = deps
  const enabled = options.tools ?? { chat: true, chats: true, tasks: true, legacy: false }
  const policy = () => (typeof deps.policy === 'function' ? deps.policy() : deps.policy) ?? {}
  const legacyDefs = agentTools((o) => o, deps)
  const legacy = new Map(legacyDefs.map((d) => [d.name, d]))
  const defs = []

  const fail = (text) => ({ ok: false, text })
  const sessionOf = (exec) => exec?.agent?.session?.id

  async function delegate(name, args, exec) {
    const def = legacy.get(name)
    if (!def) return fail(`internal: ${name} is unavailable`)
    try {
      const value = await def.execute(args, exec)
      const text = renderBlocks(def.output.render(args, value))
      return { ok: value?.ok !== false, text, data: value }
    } catch (error) {
      return fail(String(error?.message || error))
    }
  }

  const guarded = (fn) => async (args, exec) => {
    try {
      return await fn(args ?? {}, exec)
    } catch (error) {
      return fail(String(error?.message || error))
    }
  }

  if (enabled.chat !== false) {
    defs.push(defineTool({
      name: 'chat',
      description: [
        'Manage THIS chat\'s context and messages. Actions:',
        'context: what fills your context, largest first (with seq numbers).',
        'drop / undrop: remove items from your context (they stay in the transcript); select with seqs, last, tool, file or larger.',
        'pin / unpin / pins: keep a message verbatim across resets (target: message id or "last").',
        'edit / versions: replace one of your earlier final answers (target, text, reason); every version is kept for the user.',
        'new: reset this chat to a handoff you write from the full context (runs when your turn ends). compact: condense the history. clear: empty the context (usually reserved to the user).',
        'inbox / mark_read: silent messages other chats posted here.',
        'recall: search this chat\'s earlier epochs (archives of resets, dropped items, handoffs) with query; use it instead of reading archive files.',
        'relay: send every final answer of this chat to another chat as a ghost (target = chat, or "off").',
        'checkpoint: mark this point (text = a short name) before something risky, so the user can rewind the chat and your file edits to it.',
      ].join(' '),
      parameters: {
        action: { type: 'string', enum: ['context', 'drop', 'undrop', 'pin', 'unpin', 'pins', 'edit', 'versions', 'new', 'compact', 'clear', 'inbox', 'mark_read', 'recall', 'relay', 'checkpoint'], required: true },
        query: { type: 'string', description: 'recall: words to find ("quotes" for a phrase).' },
        target: { type: 'string', description: 'Message id, "last", a seq, a pin id or a drop id (by action).' },
        seqs: { type: 'array', items: { type: 'integer' }, description: 'drop: exact items from context.' },
        last: { type: 'integer', description: 'drop: the n most recent tool outputs.' },
        tool: { type: 'string', description: 'drop: every output of this tool.' },
        file: { type: 'string', description: 'drop: tool outputs whose call mentions this text.' },
        larger: { type: 'integer', description: 'drop: tool outputs above this many tokens.' },
        text: { type: 'string', description: 'edit: the new text. pin: an optional note.' },
        reason: { type: 'string', description: 'edit: why (shown to the user).' },
        focus: { type: 'string', description: 'new / compact: what the handoff must keep.' },
      },
      output: { schema: RESULT_SCHEMA, render: (_a, v) => TEXT(v.text) },
      execute: guarded(async (args, exec) => {
        const sessionId = sessionOf(exec)
        if (!sessionId) return fail('this tool needs a chat context')
        const p = policy()
        const action = args.action
        if (['drop', 'undrop', 'edit', 'pin', 'unpin', 'new', 'compact', 'clear'].includes(action)) {
          const key = action === 'undrop' ? 'drop' : action === 'unpin' ? 'pin' : action
          if (!policyAllows(p, key)) return fail(`The user has not allowed the assistant to ${action} in this chat. Ask them to do it (e.g. /${action === 'compact' ? 'force-compact' : action}).`)
        }
        switch (action) {
          case 'context': {
            const view = await conductor.view(sessionId)
            return { ok: true, text: contextSummary(view, 20) }
          }
          case 'drop': {
            const selector = {}
            if (Array.isArray(args.seqs) && args.seqs.length) selector.seqs = args.seqs
            if (Number.isInteger(args.last)) selector.last = args.last
            if (args.tool) selector.tool = args.tool
            if (args.file) selector.file = args.file
            if (Number.isFinite(args.larger)) selector.larger = args.larger
            if (args.target && args.target !== 'last') selector.messageIds = [args.target]
            if (Object.keys(selector).length === 0) return fail('say what to drop: seqs, last, tool, file or larger (see action "context")')
            const result = await conductor.drop(sessionId, selector, { by: 'model' })
            return { ok: result.ok, text: result.text, data: { dropped: result.dropped, tokens: result.tokens, ids: result.ids } }
          }
          case 'undrop': {
            const result = await conductor.undrop(sessionId, args.target || 'last', { by: 'model' })
            return { ok: result.ok, text: result.text }
          }
          case 'pin': {
            const result = await conductor.pin(sessionId, args.target || 'last', { note: args.text, by: 'model' })
            return { ok: true, text: result.text, data: { id: result.pin.id } }
          }
          case 'unpin': {
            const result = conductor.unpin(sessionId, args.target || 'last', { by: 'model' })
            return { ok: result.ok, text: result.text }
          }
          case 'pins': {
            const pins = conductor.store.get(sessionId).pins
            return { ok: true, text: pins.length ? pins.map((pin) => `${pin.id} (${pin.role}, ${fmtTokens(pin.tokens)} tokens, by ${pin.by}): ${pin.text.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n') : 'No pins.' }
          }
          case 'edit': {
            if (!args.text) return fail('edit needs the new text')
            const result = await conductor.edit(sessionId, args.target || 'last', args.text, { by: 'model', reason: args.reason })
            return { ok: result.ok, text: result.text }
          }
          case 'versions': {
            const versions = conductor.store.get(sessionId).versions
            return { ok: true, text: versions.length ? versions.map((v) => `${v.messageId}: ${v.versions.length} versions, current v${v.current}`).join('\n') : 'No edited messages.' }
          }
          case 'new':
          case 'compact':
          case 'clear': {
            const kind = action === 'compact' ? 'force-compact' : action
            const result = await conductor.scheduleReset(exec.agent, kind, { focus: args.focus, by: 'model' })
            return { ok: result.ok, text: result.text }
          }
          case 'inbox': {
            const inbox = [...conductor.store.get(sessionId).inbox].reverse().slice(0, 30)
            return { ok: true, text: inbox.length ? inbox.map((e) => `${e.id} ${e.read ? '' : '[unread] '}from ${e.from.label} at ${e.at}: ${e.text.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n') : 'Inbox is empty.' }
          }
          case 'recall': {
            if (!args.query) return fail('recall needs a query')
            const result = conductor.recallFor(sessionId, args.query, { limit: 6 })
            return { ok: result.ok, text: result.text }
          }
          case 'relay': {
            if (!args.target) return fail('relay needs a target chat (or "off")')
            const result = await conductor.setRelay(sessionId, args.target, { by: 'model' })
            return { ok: result.ok, text: result.text }
          }
          case 'checkpoint': {
            if (!conductor.checkpoints) return fail('checkpoints are not available')
            const result = conductor.checkpoints.mark(sessionId, args.text || args.target || undefined, { by: 'model' })
            return { ok: true, text: result.text }
          }
          case 'mark_read': {
            const result = conductor.markRead(sessionId, args.target ? [args.target] : 'all')
            return { ok: true, text: `Marked ${result.changed === 1 ? "1 message" : `${result.changed} messages`} read.` }
          }
          default:
            return fail(`unknown action ${action}`)
        }
      }),
    }))
  }

  if (enabled.chats !== false) {
    defs.push(defineTool({
      name: 'chats',
      description: [
        'Work with OTHER chats. Actions:',
        'list (search, live, limit); status (chat); prompt (chat, text: delivers a message and WAKES that chat);',
        'post (chat, text, kind, visible: a SILENT message, shown there and read on its next turn, never wakes it; use it for reports to a coordinator);',
        'spawn (text = first prompt, title, count, preset, cwd); fork (chat, text, title); cancel (chat).',
        'chat accepts an id, a unique id prefix or an exact title.',
      ].join(' '),
      parameters: {
        action: { type: 'string', enum: ['list', 'status', 'prompt', 'post', 'spawn', 'fork', 'cancel'], required: true },
        chat: { type: 'string', description: 'Target chat: id, unique prefix or exact title.' },
        text: { type: 'string', description: 'prompt/post: the message. spawn/fork: the first prompt.' },
        kind: { type: 'string', enum: ['report', 'alert', 'note'], description: 'post: styling only.' },
        visible: { type: 'string', enum: ['user', 'user+model'], description: 'post: default user+model.' },
        title: { type: 'string' },
        count: { type: 'integer', description: 'spawn: parallel copies (1-8); {i} in title/text is replaced.' },
        preset: { type: 'string' },
        cwd: { type: 'string' },
        search: { type: 'string', description: 'list: title filter.' },
        live: { type: 'boolean', description: 'list: only loaded chats.' },
        limit: { type: 'integer' },
      },
      output: { schema: RESULT_SCHEMA, render: (_a, v) => TEXT(v.text) },
      execute: guarded(async (args, exec) => {
        const p = policy()
        switch (args.action) {
          case 'list': return delegate('orch_agents_list', { live: args.live, search: args.search, limit: args.limit }, exec)
          case 'status': return delegate('orch_agent_status', { agent: args.chat }, exec)
          case 'prompt':
            if (!policyAllows(p, 'prompt')) return fail('prompting other chats is disabled in Conductor settings')
            return delegate('orch_agent_prompt', { agent: args.chat, message: args.text }, exec)
          case 'post': {
            if (!policyAllows(p, 'post')) return fail('posting to other chats is disabled in Conductor settings')
            const result = await conductor.post({ to: args.chat, text: args.text, kind: args.kind, visible: args.visible ?? 'user+model', fromSessionId: sessionOf(exec) }, { by: 'model' })
            return { ok: result.ok, text: result.text }
          }
          case 'spawn':
            if (!policyAllows(p, 'spawn')) return fail('spawning chats is disabled in Conductor settings')
            return delegate('orch_agent_spawn', { prompt: args.text, title: args.title, count: args.count, preset: args.preset, cwd: args.cwd }, exec)
          case 'fork':
            if (!policyAllows(p, 'spawn')) return fail('forking chats is disabled in Conductor settings')
            return delegate('orch_agent_fork', { agent: args.chat, prompt: args.text, title: args.title }, exec)
          case 'cancel':
            if (!policyAllows(p, 'cancel')) return fail('cancelling other chats is disabled in Conductor settings')
            return delegate('orch_agent_cancel', { agent: args.chat }, exec)
          default:
            return fail(`unknown action ${args.action}`)
        }
      }),
    }))
  }

  if (enabled.tasks !== false) {
    const create = legacy.get('orch_task_create')
    const createParams = { ...(create?.parameters ?? {}) }
    delete createParams.type
    defs.push(defineTool({
      name: 'tasks',
      description: [
        'Tracked background work. Actions: overview; create (type: command = shell on a runner, scrape = deterministic URL extraction, http = endpoint call, agent = a spawned chat whose answer is the output);',
        'list (status, owner, limit); status / output (id, tail); cancel (id, reason); runners (probe); providers.',
      ].join(' '),
      parameters: {
        action: { type: 'string', enum: ['overview', 'create', 'list', 'status', 'output', 'cancel', 'runners', 'providers'], required: true },
        id: { type: 'string', description: 'Task id (status, output, cancel).' },
        type: { type: 'string', description: 'create: command | scrape | http | agent. list: type filter.' },
        status: { type: 'string', description: 'list: queued | running | completed | failed | cancelled | interrupted.' },
        owner: { type: 'string', description: 'list: a session id.' },
        tail: { type: 'integer', description: 'output: last N characters.' },
        reason: { type: 'string' },
        probe: { type: 'boolean', description: 'runners: run health probes.' },
        limit: { type: 'integer' },
        ...createParams,
      },
      output: { schema: RESULT_SCHEMA, render: (_a, v) => TEXT(v.text) },
      execute: guarded(async (args, exec) => {
        switch (args.action) {
          case 'overview': return delegate('orch_status', {}, exec)
          case 'create': {
            const { action: _a, id: _i, status: _s, owner: _o, tail: _t, reason: _r, probe: _p, limit: _l, ...spec } = args
            return delegate('orch_task_create', spec, exec)
          }
          case 'list': return delegate('orch_task_list', { status: args.status, type: args.type, owner: args.owner, limit: args.limit }, exec)
          case 'status': return delegate('orch_task_status', { taskId: args.id }, exec)
          case 'output': return delegate('orch_task_output', { taskId: args.id, tail: args.tail }, exec)
          case 'cancel': return delegate('orch_task_cancel', { taskId: args.id, reason: args.reason }, exec)
          case 'runners': return delegate('orch_runners', { probe: args.probe }, exec)
          case 'providers': return delegate('orch_providers', {}, exec)
          default:
            return fail(`unknown action ${args.action}`)
        }
      }),
    }))
  }

  // The legacy orch_* names, for prompts written against dsh-orchestrator.
  const legacyOut = enabled.legacy ? agentTools(rawDefineTool, deps) : []
  return [...defs, ...legacyOut]
}
