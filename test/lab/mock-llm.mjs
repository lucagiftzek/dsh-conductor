#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible chat-completions server for the lab DSH
 * instance. No model, no network, no secrets: every reply is scripted from the
 * last user message, and every request is recorded so end-to-end tests can
 * assert exactly what the model would have seen.
 *
 * Scripts (in the last user text):
 *   [[tool:NAME {json args}]]   reply with ONE tool call to NAME (once: the
 *                               following tool result gets a plain reply)
 *   [[big N]]                   reply with about N characters of filler text
 *   [[tool:A {..}]] [[tool:B {..}]]  several markers: one call each, in order, after each result
 *   [[fail STATUS N]]           the first N requests of that prompt answer HTTP STATUS (429, 402, 503)
 *   [[truncate]]                the reply stops with finish_reason "length" (output limit)
 *   [[slow-handoff]]            anywhere in the history: the handoff reply waits 6 s (cancel tests)
 *   anything else               "mock reply: <first 60 chars>"
 *
 * Demo replies (screenshots without visible markers): a prompt whose exact
 * text (trimmed) is a key of the JSON file named by MOCK_DEMO_FILE (default
 * test/lab/demo-replies.json) gets its scripted answer:
 *   { "reply": "markdown" }
 *   { "tools": [{ "name": "read", "args": { ... } }], "reply": "final text after the tools" }
 *   "title": "Chat title"   optional, answers DSH's session title request
 * The file is read on every request, so it can be edited while the mock runs.
 * With MOCK_DEMO_MODE=1 (test/lab/demo.sh) a "__handoff" entry replaces the
 * MOCK-HANDOFF reply, delayed by MOCK_HANDOFF_DELAY_MS.
 * Compaction and handoff instructions (detected by their wording) get a
 * structured checkpoint whose first line names the instruction kind.
 *
 * Usage: node mock-llm.mjs [port] [logfile]
 *   GET  /log            the recorded requests (JSON array)
 *   POST /log/reset      clear the record
 */
import { createServer } from 'node:http'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.argv[2] || 3194)
const LOG = process.argv[3] || '/tmp/dsh-lab-mock-llm.jsonl'
const record = []
const failCounts = new Map()

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
}

function summarise(messages) {
  return messages.map((m) => ({
    role: m.role,
    chars: textOf(m.content).length + JSON.stringify(m.tool_calls ?? '').length,
    text: textOf(m.content).slice(0, 4000),
    tool_calls: m.tool_calls?.map((c) => c.function?.name),
  }))
}

const DEMO_FILE = process.env.MOCK_DEMO_FILE || join(dirname(fileURLToPath(import.meta.url)), 'demo-replies.json')

/** The demo script table, or {} when the file is missing or invalid. */
function demoTable() {
  try {
    const table = JSON.parse(readFileSync(DEMO_FILE, 'utf8'))
    return table && typeof table === 'object' && !Array.isArray(table) ? table : {}
  } catch { return {} }
}

/** The demo entry for the newest run of user messages (prompt plus any notices around it), or null. */
function demoFor(messages, end, table) {
  let i = end
  while (i >= 0 && messages[i].role !== 'user') i -= 1
  for (; i >= 0 && messages[i].role === 'user'; i -= 1) {
    const entry = table[textOf(messages[i].content).trim()]
    if (entry && typeof entry === 'object') return entry
  }
  return null
}

const TITLE_REQUEST = 'Generate the session title from this JSON array of human messages:'

const TOOL_MARKER = /\[\[tool:([a-zA-Z0-9_]+)\s+(\{[\s\S]*?\})\]\]/g

function scriptFor(body) {
  const messages = body.messages ?? []
  const last = messages.at(-1) ?? {}
  const table = demoTable()
  if (last.role === 'tool') {
    // a scripted demo prompt: its next tool after each result, then its reply
    let a = messages.length - 1
    while (a > 0 && messages[a].role !== 'user') a -= 1
    const demo = demoFor(messages, a, table)
    if (demo) {
      const tools = Array.isArray(demo.tools) ? demo.tools : []
      const done = messages.slice(a).filter((x) => x.role === 'tool').length
      if (tools.length > done) return { toolCall: { name: tools[done].name, args: JSON.stringify(tools[done].args ?? {}) } }
      return { content: String(demo.reply ?? '') }
    }
    // a sequence of tool markers in the prompt: the next one after each result
    let u = messages.length - 1
    while (u > 0 && !(messages[u].role === 'user' && /\[\[tool:/.test(textOf(messages[u].content)))) u -= 1
    const calls = [...textOf(messages[u]?.content).matchAll(TOOL_MARKER)]
    const done = messages.slice(u).filter((x) => x.role === 'tool').length
    if (calls.length > done) return { toolCall: { name: calls[done][1], args: calls[done][2] } }
    return { content: `mock: tool result received (${textOf(last.content).slice(0, 80).replace(/\s+/g, ' ')})` }
  }
  // Every user message since the last assistant turn (the prompt plus the
  // runtime and time context snapshots DSH appends after it).
  let from = messages.length - 1
  while (from > 0 && messages[from - 1].role === 'user') from -= 1
  const lastText = messages.slice(from).filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n')
  if (/compaction engine for this AI coding assistant/.test(lastText)) {
    return { content: '## Primary Request and Intent\n- MOCK-COMPACTION checkpoint\n\n## Current Work\n- (mock)\n\n## Next Step\n- (none)' }
  }
  if (/CONDUCTOR-HANDOFF/.test(lastText)) {
    // demo mode (test/lab/demo.sh): a believable handoff, written slowly enough to screenshot the progress card
    if (process.env.MOCK_DEMO_MODE === '1' && table.__handoff) return { content: String(table.__handoff.reply ?? ''), delayMs: Number(process.env.MOCK_HANDOFF_DELAY_MS) || 0 }
    return { content: '# Handoff\n\n## 1. Role and standing orders\n- MOCK-HANDOFF written from the full conversation\n\n## 2. Goal and current state\n- mock goal\n\n## 8. Next step\n- continue' }
  }
  if (lastText.includes(TITLE_REQUEST)) {
    try {
      const human = JSON.parse(lastText.slice(lastText.indexOf(TITLE_REQUEST) + TITLE_REQUEST.length).trim())
      const titled = (Array.isArray(human) ? human : []).map((m) => table[String(typeof m === 'string' ? m : m?.text ?? m?.content ?? '').trim()]).find((e) => e && e.title)
      if (titled) return { content: String(titled.title) }
    } catch { /* not a demo chat */ }
  }
  const demo = demoFor(messages, messages.length - 1, table)
  if (demo) {
    const tools = Array.isArray(demo.tools) ? demo.tools : []
    if (tools.length) return { toolCall: { name: tools[0].name, args: JSON.stringify(tools[0].args ?? {}) } }
    return { content: String(demo.reply ?? '') }
  }
  const tool = lastText.match(/\[\[tool:([a-zA-Z0-9_]+)\s+(\{[\s\S]*?\})\]\]/)
  if (tool) return { toolCall: { name: tool[1], args: tool[2] } }
  if (/\[\[truncate\]\]/.test(lastText)) return { content: 'This answer is cut off at the output li', truncated: true }
  const big = lastText.match(/\[\[big (\d+)\]\]/)
  if (big) return { content: 'filler '.repeat(Math.ceil(Number(big[1]) / 7)).slice(0, Number(big[1])) }
  return { content: `mock reply: ${textOf(messages[from]?.content).replace(/\s+/g, ' ').slice(0, 60)}` }
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/log') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(record))
    return
  }
  if (req.method === 'POST' && req.url === '/log/reset') {
    record.length = 0
    writeFileSync(LOG, '')
    res.writeHead(204).end()
    return
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'mock-1', object: 'model' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', async () => {
    let body
    try { body = JSON.parse(raw) } catch { res.writeHead(400).end(); return }
    const messages = body.messages ?? []
    const promptChars = raw.length
    const entry = {
      at: new Date().toISOString(),
      model: body.model,
      tools: (body.tools ?? []).map((t) => t.function?.name),
      toolsChars: JSON.stringify(body.tools ?? []).length,
      messagesChars: JSON.stringify(messages).length,
      promptChars,
      messages: summarise(messages),
    }
    record.push(entry)
    try { appendFileSync(LOG, JSON.stringify({ ...entry, messages: undefined, n: messages.length }) + '\n') } catch { /* best effort */ }
    const script = scriptFor(body)
    // [[fail STATUS N]] in the latest prompt: its first N requests fail with HTTP STATUS
    const lastUser = [...messages].reverse().find((x) => x.role === 'user' && /\[\[fail \d{3} \d+\]\]/.test(textOf(x.content)))
    const failMarker = lastUser ? textOf(lastUser.content).match(/\[\[fail (\d{3}) (\d+)\]\]/) : null
    const isLatestPrompt = lastUser && !messages.slice(messages.lastIndexOf(lastUser) + 1).some((x) => x.role === 'assistant')
    if (failMarker && isLatestPrompt && !/CONDUCTOR-HANDOFF|compaction engine/.test(JSON.stringify(messages.at(-1) ?? ''))) {
      const key = textOf(lastUser.content).slice(0, 400)
      const n = (failCounts.get(key) ?? 0) + 1
      failCounts.set(key, n)
      if (n <= Number(failMarker[2])) {
        const status = Number(failMarker[1])
        const msg = status === 402 ? 'Insufficient balance' : status === 429 ? 'Rate limit reached' : 'Service unavailable'
        res.writeHead(status, { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '1' } : {}) })
        res.end(JSON.stringify({ error: { message: msg, type: 'mock_error', code: status } }))
        return
      }
    }
    const slow = /CONDUCTOR-HANDOFF/.test(JSON.stringify(messages.at(-1) ?? '')) && /\[\[slow-handoff\]\]/.test(raw)
    const id = `chatcmpl-mock-${record.length}`
    const created = Math.floor(Date.now() / 1000)
    const usage = { prompt_tokens: Math.ceil(promptChars / 4), completion_tokens: 20, total_tokens: Math.ceil(promptChars / 4) + 20 }
    const base = { id, object: 'chat.completion.chunk', created, model: body.model }
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' })
      const message = script.toolCall
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: script.toolCall.name, arguments: script.toolCall.args } }] }
        : { role: 'assistant', content: script.content }
      res.end(JSON.stringify({ id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message, finish_reason: script.toolCall ? 'tool_calls' : 'stop' }], usage }))
      return
    }
    if (slow) await new Promise((r) => setTimeout(r, 6000))
    else if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs))
    if (res.destroyed || res.writableEnded) return // the caller went away during the delay
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
    if (script.toolCall) {
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${record.length}`, type: 'function', function: { name: script.toolCall.name, arguments: script.toolCall.args } }] }, finish_reason: null }] })
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    } else {
      const text = script.content
      for (let i = 0; i < text.length; i += 400) sse(res, { ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + 400) }, finish_reason: null }] })
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: script.truncated ? 'length' : 'stop' }] })
    }
    sse(res, { ...base, choices: [], usage })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`mock-llm listening on 127.0.0.1:${PORT}, log ${LOG}`))
