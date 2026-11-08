/**
 * The model-visible surface of one chat: inventory, drop, undrop and edit.
 *
 * DSH keeps an append-only log; what the model sees (the "surface") is
 * derived from it. Nothing here deletes anything: every change is a new
 * `replace` event that shadows a range of earlier nodes and cites them in
 * `sourceEventSeqs`, so the originals stay in the log, in the chat transcript
 * and in the side files this module writes.
 *
 * Rules enforced here (from dsh-session/surface.js):
 *   - node 0 (the system prompt) is never touched;
 *   - a tool/result replace hits exactly one tool/result and changes only
 *     message.content (the shape the core tool-result pruner writes);
 *   - an assistant message can never be a replacement, so an assistant step is
 *     replaced by a user/message placeholder, over a balanced range only;
 *   - nothing is changed while a compaction is open.
 */
import { randomUUID } from 'node:crypto'

export const SOURCE_KIND = 'dsh-conductor'
/** Silent messages from other chats or scripts ("ghosts"): the chat UI renders them as messages with a Ghost label. */
export const POST_SOURCE_KIND = 'dsh-conductor-post'

const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')

export function messageOf(event) {
  // user/message carries the message itself; every other message event wraps it in { message }
  if (event?.type === 'user/message') return event.data
  return event?.data?.message
}

/** Map seq -> event over the whole log (one snapshot). */
export function eventIndex(session) {
  const map = new Map()
  for (const event of session.snapshotEvents()) map.set(Number(event.seq), event)
  return map
}

/** callId -> { name, args } from every assistant tool call in the log. */
export function toolCalls(events) {
  const out = new Map()
  for (const event of events.values()) {
    if (event.type !== 'assistant/message') continue
    for (const block of messageOf(event)?.content ?? []) {
      if (block?.type === 'tool-call') out.set(block.id, { name: block.name, args: String(block.arguments ?? '') })
    }
  }
  return out
}

/** True while a compaction bracket is open (an unmatched compaction/start after the latest seed boundary). */
export function compactionOpen(events) {
  let open = false
  for (const event of events.values()) {
    if (event.type === 'session/end-seed') open = false
    else if (event.type === 'compaction/start') open = true
    else if (event.type === 'compaction/end') open = false
  }
  return open
}

function argsSummary(args, max = 90) {
  let parsed
  try { parsed = JSON.parse(args) } catch { return args.replace(/\s+/g, ' ').slice(0, max) }
  if (!parsed || typeof parsed !== 'object') return String(parsed).slice(0, max)
  const preferred = ['file_path', 'path', 'command', 'url', 'query', 'pattern', 'selector', 'name', 'action', 'prompt', 'description']
  for (const key of preferred) {
    if (typeof parsed[key] === 'string' && parsed[key].trim()) return parsed[key].replace(/\s+/g, ' ').slice(0, max)
  }
  return JSON.stringify(parsed).slice(0, max)
}

/** Category of one surface node, for the context meter and the inspector. */
export function categoryOf(event) {
  const message = messageOf(event)
  const kind = message?.source?.kind
  if (event.type === 'system/message') return 'system'
  if (event.type === 'tool/result') return 'tool'
  if (event.type === 'assistant/message') return 'assistant'
  if (event.type === 'developer/message') return 'context'
  if (kind === 'compact-checkpoint') return 'checkpoint'
  if (kind === SOURCE_KIND || kind === POST_SOURCE_KIND || kind === 'dsh-conductor-rewind') return 'conductor'
  if (kind === 'user' || kind === 'user-rpc' || kind === undefined) return 'user'
  return 'context'
}

/**
 * Every node the model sees, oldest first.
 * @param session live Session (surface + snapshotEvents)
 * @param options.tokens Map seq -> tokens (from the token meter), optional
 * @param options.dropped Map placeholderSeq -> drop record, optional
 * @param options.pinned Set of message ids, optional
 */
export function inventory(session, options = {}) {
  const events = options.events ?? eventIndex(session)
  const calls = toolCalls(events)
  const nodes = session.surface.nodes.map(Number)
  const items = []
  nodes.forEach((seq, index) => {
    const event = events.get(seq)
    if (!event) return
    const message = messageOf(event) ?? {}
    const category = categoryOf(event)
    const text = textOf(message.content)
    const chars = JSON.stringify(message.content ?? '').length
    const tokens = options.tokens?.get(seq) ?? Math.ceil(chars / 4)
    let label
    let tool
    if (category === 'tool') {
      const call = calls.get(message.toolCallId ?? message.source?.callId)
      tool = call?.name
      label = call ? `${call.name}: ${argsSummary(call.args)}` : 'Tool result'
    } else if (category === 'assistant') {
      const toolNames = (message.content ?? []).filter((b) => b?.type === 'tool-call').map((b) => b.name)
      label = text.trim() ? text.trim().replace(/\s+/g, ' ').slice(0, 90) : toolNames.length ? `Calls ${toolNames.join(', ')}` : 'Assistant step'
    } else if (category === 'system') {
      label = 'System prompt'
    } else if (category === 'checkpoint') {
      label = /CONDUCTOR-HANDOFF|# Handoff/.test(text) ? 'Handoff (from /new)' : 'Compaction checkpoint'
    } else if (category === 'context') {
      label = `Context: ${message.source?.kind ?? event.type}`
    } else {
      label = text.trim().replace(/\s+/g, ' ').slice(0, 90) || '(empty)'
    }
    const dropped = options.dropped?.get(seq)
    items.push({
      seq,
      index,
      type: event.type,
      role: message.role,
      category,
      source: message.source?.kind,
      messageId: message.id,
      tool,
      label,
      preview: text.slice(0, 600),
      chars,
      tokens,
      replaced: event.surfaceOp && typeof event.surfaceOp === 'object',
      dropped: dropped ? { id: dropped.id, at: dropped.at, by: dropped.by, undoable: dropped.kind !== 'step' } : undefined,
      pinned: message.id ? Boolean(options.pinned?.has(message.id)) : false,
      droppable: index > 0 && !dropped && (category === 'tool' || category === 'user' || category === 'assistant' || category === 'conductor' || category === 'context'),
      time: event.time ? new Date(event.time).toISOString() : undefined,
    })
  })
  return items
}

/**
 * Turn a selector into concrete drop operations against the current surface.
 * Selector forms (all optional, combined with OR):
 *   seqs: number[]          exact surface nodes
 *   messageIds: string[]    nodes by message id
 *   last: n                 the n most recent tool outputs
 *   tool: name              every output of one tool (olderThan: keep the newest k)
 *   file: substring         every tool output whose call arguments mention it
 *   larger: tokens          every tool output above a size
 * Assistant nodes expand to their whole step (the message plus its tool results).
 * @returns {{ ops: object[], skipped: object[] }}
 */
export function planDrop(items, selector = {}, balance = null) {
  const bySeq = new Map(items.map((item) => [item.seq, item]))
  const chosen = new Set()
  const tools = items.filter((item) => item.category === 'tool' && item.droppable)
  for (const seq of selector.seqs ?? []) if (bySeq.has(Number(seq))) chosen.add(Number(seq))
  for (const id of selector.messageIds ?? []) {
    const hit = items.find((item) => item.messageId === id)
    if (hit) chosen.add(hit.seq)
  }
  if (Number.isInteger(selector.last) && selector.last > 0) for (const item of tools.slice(-selector.last)) chosen.add(item.seq)
  if (typeof selector.tool === 'string' && selector.tool) {
    const matches = tools.filter((item) => item.tool === selector.tool)
    const keep = Number.isInteger(selector.keepNewest) ? selector.keepNewest : 0
    for (const item of matches.slice(0, Math.max(0, matches.length - keep))) chosen.add(item.seq)
  }
  if (typeof selector.file === 'string' && selector.file) {
    for (const item of tools) if (item.label.includes(selector.file)) chosen.add(item.seq)
  }
  if (Number.isFinite(selector.larger) && selector.larger > 0) {
    for (const item of tools) if (item.tokens >= selector.larger) chosen.add(item.seq)
  }

  const ops = []
  const skipped = []
  const covered = new Set()
  const ordered = [...chosen].sort((a, b) => a - b)
  const push = (op) => {
    if (op.tokens <= placeholderTokens(op)) {
      skipped.push({ seq: op.start, reason: 'too small: its placeholder would cost as much as it saves' })
      return false
    }
    ops.push(op)
    return true
  }
  for (const seq of ordered) {
    if (covered.has(seq)) continue
    const item = bySeq.get(seq)
    if (!item) continue
    if (!item.droppable) {
      skipped.push({ seq, reason: item.index === 0 ? 'the system prompt is never dropped' : item.dropped ? 'already dropped' : `a ${item.category} node cannot be dropped` })
      continue
    }
    if (item.pinned) {
      skipped.push({ seq, reason: 'pinned: unpin it first' })
      continue
    }
    if (item.category === 'tool') {
      if (push({ kind: 'tool', start: seq, end: seq, seqs: [seq], label: item.label, tokens: item.tokens })) covered.add(seq)
      continue
    }
    if (item.category === 'assistant') {
      const range = [seq]
      let i = item.index + 1
      while (i < items.length && items[i].category === 'tool') {
        range.push(items[i].seq)
        i += 1
      }
      const end = range.at(-1)
      if (balance && !(balance.before(seq) && balance.after(end))) {
        skipped.push({ seq, reason: 'this step is still open or not balanced' })
        continue
      }
      if (!balance) {
        skipped.push({ seq, reason: 'step drops need the core balance helpers, which are unavailable' })
        continue
      }
      if (range.some((s) => bySeq.get(s)?.pinned)) {
        skipped.push({ seq, reason: 'part of this step is pinned' })
        continue
      }
      const tokens = range.reduce((sum, s) => sum + (bySeq.get(s)?.tokens ?? 0), 0)
      if (push({ kind: 'step', start: seq, end, seqs: range, label: item.label, tokens, toolResults: range.length - 1 })) for (const s of range) covered.add(s)
      continue
    }
    // user, conductor notices and context snapshots: single user/developer node
    if (balance && !(balance.before(seq) && balance.after(seq))) {
      skipped.push({ seq, reason: 'this message sits inside an open step' })
      continue
    }
    if (!balance) {
      skipped.push({ seq, reason: 'message drops need the core balance helpers, which are unavailable' })
      continue
    }
    if (push({ kind: item.type === 'developer/message' ? 'developer' : 'user', start: seq, end: seq, seqs: [seq], label: item.label, tokens: item.tokens })) covered.add(seq)
  }
  return { ops, skipped }
}

export function noticeMessage(text, summary, kind = SOURCE_KIND) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind, form: 'notice', summary: String(summary).slice(0, 120) },
  }
}

/** Keep the file pointer only when the item is big enough for it to matter. */
export const SAVE_POINTER_MIN_TOKENS = 300

export function placeholderText(op, who, file) {
  const where = file && op.tokens >= SAVE_POINTER_MIN_TOKENS ? ` Saved: \`${file}\`` : ''
  const label = op.label.replace(/\s+/g, ' ').slice(0, 60)
  if (op.kind === 'tool') return `[Tool output removed by ${who}: ${label}, ~${op.tokens} tokens.${where}]`
  if (op.kind === 'step') return `[Assistant step removed by ${who}: ${label}${op.toolResults ? `, with ${op.toolResults} tool ${op.toolResults === 1 ? 'result' : 'results'}` : ''}, ~${op.tokens} tokens.${where}]`
  return `[Message removed by ${who}: "${label}", ~${op.tokens} tokens.${where}]`
}

/** Tokens the placeholder itself costs (a 110-character saved-file path is assumed when it will be shown). */
export function placeholderTokens(op) {
  const path = op.tokens >= SAVE_POINTER_MIN_TOKENS ? 'x'.repeat(110) : null
  return Math.ceil(placeholderText(op, 'the assistant', path).length / 4) + 8
}

/**
 * Append the replace events for one planned op. Returns the placeholder event.
 * `events` is the seq -> event index used to plan (re-validated here).
 */
export function applyDrop(session, events, op, who, file) {
  const text = placeholderText(op, who, file)
  if (op.kind === 'tool') {
    const event = events.get(op.start)
    const message = messageOf(event)
    return session.append('tool/result', { ...event.data, message: { ...message, content: [{ type: 'text', text }] } }, {
      surfaceOp: { op: 'replace', startSeq: op.start, endSeq: op.end },
      sourceEventSeqs: [op.start],
    })
  }
  if (op.kind === 'developer') {
    const event = events.get(op.start)
    const message = messageOf(event)
    return session.append('developer/message', { ...event.data, message: { ...message, id: randomUUID(), content: [{ type: 'text', text }] } }, {
      surfaceOp: { op: 'replace', startSeq: op.start, endSeq: op.end },
      sourceEventSeqs: [...op.seqs],
    })
  }
  return session.append('user/message', noticeMessage(text, `Removed from context: ${op.label}`), {
    surfaceOp: { op: 'replace', startSeq: op.start, endSeq: op.end },
    sourceEventSeqs: [...op.seqs],
  })
}

/** Put a dropped tool output or user message back (the placeholder node is replaced by the original content). */
export function applyUndrop(session, events, record) {
  const placeholder = events.get(record.placeholderSeq)
  const original = events.get(record.start)
  if (!placeholder || !original) throw new Error('the dropped item is no longer in the log')
  if (record.kind === 'tool') {
    return session.append('tool/result', { ...placeholder.data, message: { ...messageOf(placeholder), content: messageOf(original).content } }, {
      surfaceOp: { op: 'replace', startSeq: record.placeholderSeq, endSeq: record.placeholderSeq },
      sourceEventSeqs: [record.placeholderSeq],
    })
  }
  if (record.kind === 'user') {
    const message = messageOf(original)
    return session.append('user/message', { ...message, id: randomUUID() }, {
      surfaceOp: { op: 'replace', startSeq: record.placeholderSeq, endSeq: record.placeholderSeq },
      sourceEventSeqs: [record.placeholderSeq],
    })
  }
  throw new Error('an assistant step cannot be put back as it was (the model only accepts it as quoted text); it stays in the chat log and the saved file')
}

/**
 * Replace one message's model-visible content (message versions). A user
 * message keeps its role. An assistant message becomes a quoted user notice,
 * because the log never accepts an assistant replacement.
 */
export function applyEdit(session, events, seq, { text, role, version, author, reason }) {
  const event = events.get(seq)
  if (!event) throw new Error('message not found in the log')
  const range = { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] }
  if (role === 'user' && event.type === 'user/message') {
    const message = messageOf(event)
    return session.append('user/message', { ...message, id: randomUUID(), content: [{ type: 'text', text }] }, range)
  }
  const header = `[Your earlier answer, version ${version}, edited by ${author}${reason ? `: ${reason}` : ''}]`
  return session.append('user/message', noticeMessage(`${header}\n${text}`, `Edited answer (version ${version})`), range)
}
