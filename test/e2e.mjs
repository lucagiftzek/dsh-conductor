#!/usr/bin/env node
/**
 * End-to-end tests against the LAB instance (never the live dsh-web):
 *   DSH_HOME=~/dsh-lab dsh --profile lab --port 3193 with test/lab/probe mounted,
 *   and test/lab/mock-llm.mjs on 3194 as the only model.
 *
 * Every assertion reads the real session log, the real surface and the exact
 * requests the model received. Run: node test/e2e.mjs [--only name]
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { harnessCookieName } from '../lib/security.js'

const LAB = process.env.LAB_URL || 'http://127.0.0.1:3193'
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:3194'
const PROBE = `${LAB}/lab-probe/api`
const API = `${LAB}/dsh-conductor/api`
const H = { 'x-lab-token': process.env.LAB_PROBE_TOKEN || 'lab', 'content-type': 'application/json' }
const UI = { host: new URL(LAB).host, 'content-type': 'application/json', 'x-requested-with': 'dsh-conductor', origin: LAB, 'sec-fetch-site': 'same-origin', cookie: `${harnessCookieName(new URL(LAB).host)}=lab` }

async function call(url, { method = 'GET', body, headers = H } = {}) {
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: res.status, ...json }
}
const created = []
const probe = {
  create: () => call(`${PROBE}/create`, { method: 'POST', body: { cwd: '/tmp' } }).then((r) => { created.push(r.sessionId); return r.sessionId }),
  verify: (sessionId) => call(`${PROBE}/verify?sessionId=${sessionId}`),
  prompt: (sessionId, text) => call(`${PROBE}/prompt`, { method: 'POST', body: { sessionId, text } }),
  command: (sessionId, line) => call(`${PROBE}/command`, { method: 'POST', body: { sessionId, line } }).then((r) => r.result),
  state: (sessionId) => call(`${PROBE}/state?sessionId=${sessionId}`),
  events: (sessionId) => call(`${PROBE}/events?sessionId=${sessionId}`).then((r) => r.events),
  wait: (sessionId) => call(`${PROBE}/wait`, { method: 'POST', body: { sessionId } }),
}
const ui = {
  view: (sessionId) => call(`${API}/conductor/session/${sessionId}`, { headers: UI }),
  post: (path, body) => call(`${API}${path}`, { method: 'POST', body, headers: UI }),
}
const mock = {
  reset: () => fetch(`${MOCK}/log/reset`, { method: 'POST' }),
  log: () => fetch(`${MOCK}/log`).then((r) => r.json()),
}
const allText = (request) => request.messages.map((m) => m.text).join('\n')
const turnRequests = (log) => log.filter((r) => r.messages[0]?.role === 'system' && !/Create a concise title/.test(r.messages[0].text))

async function seeded() {
  const sessionId = await probe.create()
  await probe.prompt(sessionId, 'build the thing [[big 9000]]')
  await probe.prompt(sessionId, 'read it [[tool:read {"file_path":"/etc/services"}]]')
  await probe.prompt(sessionId, 'standing order: always deploy with the green button')
  return sessionId
}

test('lab is up (probe, conductor route, mock model)', async () => {
  const health = await call(`${API}/health`, { headers: UI })
  assert.equal(health.ok, true, JSON.stringify(health))
  assert.equal((await fetch(`${MOCK}/log`)).ok, true)
})

test('/new: in place, handoff becomes the history, pins kept, token parity with a fresh chat', async () => {
  const sessionId = await seeded()
  const pinned = await probe.command(sessionId, '/pin user the deploy rule')
  assert.equal(pinned.kind, 'success', JSON.stringify(pinned))
  const before = await probe.state(sessionId)
  await mock.reset()
  const result = await probe.command(sessionId, '/new keep the deploy notes')
  assert.equal(result.kind, 'success', JSON.stringify(result))
  assert.match(result.text, /Fresh context from a handoff: .* to .* tokens/)
  const handoffPath = result.text.match(/Handoff: (\S+)/)?.[1]
  const archivePath = result.text.match(/Archive: (\S+)/)?.[1]
  assert.ok(handoffPath && existsSync(handoffPath), 'handoff file written')
  assert.ok(archivePath && existsSync(archivePath), 'archive written')
  assert.match(readFileSync(archivePath, 'utf8'), /filler filler/, 'archive holds the verbatim history')

  // the handoff call saw the WHOLE conversation plus the instruction, in one request
  const handoffCall = (await mock.log()).find((r) => /CONDUCTOR-HANDOFF/.test(allText(r)))
  assert.ok(handoffCall, 'one handoff request')
  assert.match(allText(handoffCall), /filler filler/, 'full history replayed')
  assert.match(allText(handoffCall), /keep the deploy notes/, 'focus passed')

  // same chat id, surface = system prompt + checkpoint (+ the last answer core keeps)
  const after = await probe.state(sessionId)
  assert.equal(after.id, sessionId)
  const kinds = after.nodes.map((n) => n.source)
  assert.equal(kinds[0], 'system-prompt')
  assert.equal(kinds[1], 'compact-checkpoint')
  assert.ok(after.nodes.length <= 3, `surface shrank to ${after.nodes.length} nodes`)
  assert.ok(after.tokens < before.tokens, `${after.tokens} < ${before.tokens}`)
  const checkpoint = after.nodes[1].text
  assert.match(checkpoint, /This is an automatically generated checkpoint/)

  // the next request carries the handoff, the pin and the pointer, and no old history
  await mock.reset()
  await probe.prompt(sessionId, 'what next')
  const next = turnRequests(await mock.log()).at(-1)
  const text = allText(next)
  assert.match(text, /MOCK-HANDOFF/)
  assert.match(text, /always deploy with the green button/, 'pinned message re-added verbatim')
  assert.match(text, /Earlier history/)
  assert.doesNotMatch(text, /filler filler/, 'old history gone from the model request')

  // parity: a brand new chat's first request plus the checkpoint, within 2K tokens (8K chars)
  const fresh = await probe.create()
  await mock.reset()
  await probe.prompt(fresh, 'what next')
  const freshRequest = turnRequests(await mock.log()).at(-1)
  const checkpointChars = next.messages.find((m) => /automatically generated checkpoint/.test(m.text))?.chars ?? 0
  const delta = next.promptChars - (freshRequest.promptChars + checkpointChars)
  assert.ok(Math.abs(delta) < 8000, `parity: after /new ${next.promptChars} chars vs fresh ${freshRequest.promptChars} + checkpoint ${checkpointChars} (delta ${delta})`)

  const view = await ui.view(sessionId)
  assert.equal(view.ok, true, JSON.stringify(view).slice(0, 300))
  assert.equal(view.epochs[0].kind, 'new')
  assert.ok(view.epochs[0].tokensBefore > view.epochs[0].tokensAfter)
  assert.equal(view.pins.length, 1)
})

test('/clear: placeholder only, no model call, pins kept', async () => {
  const sessionId = await seeded()
  await probe.command(sessionId, '/pin')
  await mock.reset()
  const result = await probe.command(sessionId, '/clear')
  assert.equal(result.kind, 'success', JSON.stringify(result))
  assert.match(result.text, /Context cleared/)
  assert.equal((await mock.log()).length, 0, 'no model call')
  const state = await probe.state(sessionId)
  const placeholder = await call(`${API}/conductor/session/${sessionId}/item/${state.nodes[1].seq}`, { headers: UI })
  assert.match(placeholder.text, /was cleared by the user/)
  await probe.prompt(sessionId, 'hello again')
  const text = allText(turnRequests(await mock.log()).at(-1))
  assert.match(text, /Pinned messages/)
  assert.doesNotMatch(text, /filler filler/)
})

test('/force-compact --pointer still works (merged dsh-force-compact)', async () => {
  const sessionId = await seeded()
  const result = await probe.command(sessionId, '/force-compact --pointer')
  assert.equal(result.kind, 'success', JSON.stringify(result))
  assert.match(result.text, /Mechanical checkpoint, no model call/)
  const state = await probe.state(sessionId)
  const checkpoint = await call(`${API}/conductor/session/${sessionId}/item/${state.nodes[1].seq}`, { headers: UI })
  assert.match(checkpoint.text, /mechanical checkpoint made by \/force-compact --pointer/)
})

test('/drop and /undrop: tool output out of the request and back, original kept', async () => {
  const sessionId = await seeded()
  const dropped = await probe.command(sessionId, '/drop last 1')
  assert.equal(dropped.kind, 'success', JSON.stringify(dropped))
  assert.match(dropped.text, /1 tool output \(about .*\) leaves the context when the next turn starts/)
  await mock.reset()
  await probe.prompt(sessionId, 'continue')
  let text = allText(turnRequests(await mock.log()).at(-1))
  assert.match(text, /Tool output removed by the user/)
  const events = await probe.events(sessionId)
  const replace = events.filter((e) => e.type === 'tool/result' && e.surfaceOp?.op === 'replace')
  assert.equal(replace.length, 1, 'one tool/result replace event')
  const undo = await probe.command(sessionId, '/undrop')
  assert.equal(undo.kind, 'success', JSON.stringify(undo))
  await mock.reset()
  await probe.prompt(sessionId, 'and now')
  text = allText(turnRequests(await mock.log()).at(-1))
  assert.doesNotMatch(text, /Tool output removed by/)
})

test('/drop an assistant step and a user message (balanced ranges)', async () => {
  const sessionId = await seeded()
  const view = await ui.view(sessionId)
  const big = view.items.find((i) => i.category === 'assistant' && i.tokens > 1000)
  await probe.prompt(sessionId, `notes for later: ${'lorem ipsum dolor '.repeat(120)}`)
  const fresh = await ui.view(sessionId)
  const user = fresh.items.find((i) => i.category === 'user' && /notes for later/.test(i.label))
  const small = fresh.items.find((i) => i.category === 'user' && /standing order/.test(i.label))
  const tooSmall = await ui.post(`/conductor/session/${sessionId}/drop`, { seqs: [small.seq] })
  assert.equal(tooSmall.dropped, 0)
  assert.match(tooSmall.text, /too small/)
  assert.ok(big && user, 'found the big answer and the user message')
  const res = await ui.post(`/conductor/session/${sessionId}/drop`, { seqs: [big.seq, user.seq] })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.dropped, 2)
  await mock.reset()
  await probe.prompt(sessionId, 'next')
  const text = allText(turnRequests(await mock.log()).at(-1))
  assert.doesNotMatch(text, /(filler ){40}/, 'the big answer is gone (only a short label remains)')
  assert.match(text, /Assistant step removed by the user/)
  assert.match(text, /Message removed by the user/)
})

test('edit with versions: the model sees v2, every version kept, restore v1', async () => {
  const sessionId = await seeded()
  const view = await ui.view(sessionId)
  const answer = [...view.items].reverse().find((i) => i.category === 'assistant' && /mock reply: standing order/.test(i.label))
  assert.ok(answer?.messageId)
  const edited = await ui.post(`/conductor/session/${sessionId}/edit`, { target: answer.messageId, text: 'Corrected answer: use the blue button.', reason: 'typo' })
  assert.equal(edited.ok, true, JSON.stringify(edited))
  await mock.reset()
  await probe.prompt(sessionId, 'which button')
  let text = allText(turnRequests(await mock.log()).at(-1))
  assert.match(text, /version 2, edited by the user: typo\]\nCorrected answer: use the blue button/)
  const v = await ui.view(sessionId)
  assert.equal(v.versions[0].versions.length, 2)
  const restored = await ui.post(`/conductor/session/${sessionId}/restore`, { messageId: answer.messageId, version: 1 })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  await mock.reset()
  await probe.prompt(sessionId, 'again')
  text = allText(turnRequests(await mock.log()).at(-1))
  assert.match(text, /version 3, edited by the user: restored version 1\]\nmock reply: standing order/)
})

test('silent post: lands in the target without waking it; the target reads it next turn', async () => {
  const coordinator = await probe.create()
  await probe.prompt(coordinator, 'I coordinate')
  const worker = await probe.create()
  const eventsBefore = (await probe.events(coordinator)).length
  await mock.reset()
  const posted = await ui.post('/conductor/post', { to: coordinator, text: 'Job 42 finished: 12 rows written.', kind: 'report', fromSessionId: worker })
  assert.equal(posted.ok, true, JSON.stringify(posted))
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal((await mock.log()).length, 0, 'no model call: nothing woke')
  const state = await probe.state(coordinator)
  assert.equal(state.status, 'idle')
  const events = (await probe.events(coordinator)).slice(eventsBefore)
  assert.ok(!events.some((e) => e.type === 'turn/start'), 'no turn started')
  assert.ok(!events.some((e) => e.type === 'command/run'), 'no command row by default (the client renders the ghost)')
  assert.ok(events.some((e) => e.type === 'user/message' && e.source === 'dsh-conductor-post'), 'ghost notice appended for the model and the chat UI')
  const view = await ui.view(coordinator)
  assert.equal(view.unread, 1)
  await probe.prompt(coordinator, 'anything new?')
  assert.match(allText(turnRequests(await mock.log()).at(-1)), /Silent message from [\s\S]*Job 42 finished/)
})

test('model tools: chat drop is deferred to the next step; chat new runs after the turn', async () => {
  const sessionId = await seeded()
  await mock.reset()
  await probe.prompt(sessionId, 'tidy up [[tool:chat {"action":"drop","last":1}]]')
  const log = await mock.log()
  const afterTool = turnRequests(log).at(-1)
  assert.match(allText(afterTool), /Tool output removed by the assistant/, 'applied before the next step of the same turn')
  await mock.reset()
  await probe.prompt(sessionId, 'start over [[tool:chat {"action":"new","focus":"the deploy"}]]')
  await probe.wait(sessionId)
  await new Promise((r) => setTimeout(r, 3000))
  const view = await ui.view(sessionId)
  assert.equal(view.epochs[0]?.kind, 'new', JSON.stringify(view.epochs[0]))
  assert.equal(view.epochs[0]?.by, 'model')
})

test('model tools: chats post from one chat to another', async () => {
  const target = await probe.create()
  await probe.prompt(target, 'hi')
  const source = await probe.create()
  await probe.prompt(source, `report [[tool:chats {"action":"post","chat":"${target}","text":"done: 3 files"}]]`)
  const view = await ui.view(target)
  assert.equal(view.inbox[0]?.text, 'done: 3 files')
  assert.equal(view.inbox[0]?.from.by, 'model')
})

test('sidebar view: meter, categories and items are consistent', async () => {
  const sessionId = await seeded()
  const view = await ui.view(sessionId)
  assert.ok(view.meter.total > 0)
  assert.equal(view.meter.window, 200000)
  const sum = Object.values(view.meter.categories).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - view.meter.total) <= 2, `categories ${sum} vs total ${view.meter.total}`)
  const again = await call(`${API}/conductor/session/${sessionId}`, { headers: UI })
  assert.equal(again.fingerprint, view.fingerprint)
  const cheap = await call(`${API}/conductor/session/${sessionId}?since=${encodeURIComponent(view.fingerprint)}`, { headers: UI })
  assert.equal(cheap.unchanged, true, "?since= answers unchanged when nothing moved")
})

test('idle tool drop is shown as pending, then applied at the start of the next turn', async () => {
  const sessionId = await seeded()
  const view = await ui.view(sessionId)
  const tool = view.items.find((i) => i.category === 'tool')
  const res = await ui.post(`/conductor/session/${sessionId}/drop`, { seqs: [tool.seq] })
  assert.equal(res.queued, 1, JSON.stringify(res))
  assert.equal((await ui.view(sessionId)).items.find((i) => i.seq === tool.seq)?.pendingDrop, true)
  await probe.prompt(sessionId, 'go on')
  const after = await ui.view(sessionId)
  assert.ok(!after.items.some((i) => i.seq === tool.seq), 'the original left the surface')
  assert.ok(after.items.some((i) => i.dropped && /read/.test(i.label)), 'its placeholder is marked dropped')
})

test('machine API: /remote/post needs the secret; legacy route serves the old prefix', async () => {
  const secretFile = `${process.env.LAB_HOME || `${process.env.HOME}/dsh-lab`}/run/api-secret`
  const target = await probe.create()
  const denied = await call(`${API}/remote/post`, { method: 'POST', body: { to: target, text: 'x' }, headers: { 'content-type': 'application/json', 'x-conductor-secret': 'not-the-secret-0000000' } })
  assert.ok([401, 503].includes(denied.status), JSON.stringify(denied))
  if (existsSync(secretFile)) {
    const secret = readFileSync(secretFile, 'utf8').trim()
    const ok = await call(`${API}/remote/post`, { method: 'POST', body: { to: target, text: 'from cron', from: 'cron', kind: 'report' }, headers: { 'content-type': 'application/json', 'x-conductor-secret': secret } })
    assert.equal(ok.status, 202, JSON.stringify(ok))
    const legacy = await call(`${LAB}/dsh-orchestrator/api/remote/post`, { method: 'POST', body: { to: target, text: 'via the old prefix' }, headers: { 'content-type': 'application/json', 'x-orchestrator-secret': secret } })
    assert.equal(legacy.status, 202, JSON.stringify(legacy))
    const view = await ui.view(target)
    assert.equal(view.inbox.length, 2)
    assert.equal(view.inbox[1].from.label, 'cron')
  }
  const health = await call(`${LAB}/dsh-orchestrator/api/health`, { headers: UI })
  assert.equal(health.ok, true, 'legacy prefix answers (legacyRoute: true in the lab row)')
})

test('policy: the model cannot clear the chat by default', async () => {
  const sessionId = await seeded()
  await mock.reset()
  await probe.prompt(sessionId, 'wipe [[tool:chat {"action":"clear"}]]')
  const toolResult = turnRequests(await mock.log()).at(-1).messages.filter((m) => m.role === 'tool').at(-1)
  assert.match(toolResult.text, /not allowed the assistant to clear/)
  assert.equal((await ui.view(sessionId)).epochs.length, 0)
})

test('/new can be cancelled from the sidebar; the context stays as it was', async () => {
  const sessionId = await seeded()
  await probe.prompt(sessionId, 'remember [[slow-handoff]]')
  const before = await probe.state(sessionId)
  const started = await ui.post(`/conductor/session/${sessionId}/reset`, { kind: 'new' })
  assert.equal(started.status, 202, JSON.stringify(started))
  await new Promise((r) => setTimeout(r, 1500))
  assert.ok((await ui.view(sessionId)).progress, 'progress is reported while it runs')
  const cancel = await ui.post(`/conductor/session/${sessionId}/reset/cancel`, {})
  assert.equal(cancel.ok, true, JSON.stringify(cancel))
  let view
  for (let i = 0; i < 40; i += 1) {
    view = await ui.view(sessionId)
    if (view.lastReset) break
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.equal(view.lastReset?.ok, false, JSON.stringify(view.lastReset))
  assert.match(view.lastReset.text, /cancelled|unchanged/i)
  const after = await probe.state(sessionId)
  assert.deepEqual(after.nodes.map((n) => n.seq), before.nodes.map((n) => n.seq), 'surface untouched')
  assert.equal(view.epochs.length, 0)
})

test('pending drops can be cancelled; inbox dismiss can be undone; pin notes can change', async () => {
  const sessionId = await seeded()
  const tool = (await ui.view(sessionId)).items.find((i) => i.category === 'tool')
  await ui.post(`/conductor/session/${sessionId}/drop`, { seqs: [tool.seq] })
  const cancelled = await ui.post(`/conductor/session/${sessionId}/undrop`, { target: 'pending' })
  assert.equal(cancelled.cancelled, 1, JSON.stringify(cancelled))
  await probe.prompt(sessionId, 'next')
  assert.ok((await ui.view(sessionId)).items.some((i) => i.seq === tool.seq), 'still in context')

  await ui.post('/conductor/post', { to: sessionId, text: 'hello inbox' })
  const id = (await ui.view(sessionId)).inbox[0].id
  await ui.post(`/conductor/session/${sessionId}/inbox`, { action: 'dismiss', ids: [id] })
  assert.equal((await ui.view(sessionId)).inbox.length, 0)
  await ui.post(`/conductor/session/${sessionId}/inbox`, { action: 'undismiss', ids: [id] })
  assert.equal((await ui.view(sessionId)).inbox[0]?.id, id)

  const pin = await ui.post(`/conductor/session/${sessionId}/pin`, { target: 'last' })
  const noted = await ui.post(`/conductor/session/${sessionId}/pin-note`, { target: pin.pin.id, note: 'the rule' })
  assert.equal(noted.ok, true, JSON.stringify(noted))
  assert.equal((await ui.view(sessionId)).pins[0].note, 'the rule')
})

test('recall: after /new the earlier epoch is searchable by command and by the model tool', async () => {
  const sessionId = await seeded()
  await probe.prompt(sessionId, 'the launch codename is BLUEHERON, remember it')
  assert.equal((await probe.command(sessionId, '/new')).kind, 'success')
  const found = await probe.command(sessionId, '/recall BLUEHERON codename')
  assert.equal(found.kind, 'success', JSON.stringify(found))
  assert.match(found.text, /archive.*:\d+-\d+[\s\S]*BLUEHERON/)
  await mock.reset()
  await probe.prompt(sessionId, 'what was the codename [[tool:chat {"action":"recall","query":"codename BLUEHERON"}]]')
  const toolResult = turnRequests(await mock.log()).at(-1).messages.filter((m) => m.role === 'tool').at(-1)
  assert.match(toolResult.text, /BLUEHERON/)
})

test('relay: every final answer of a worker arrives in the coordinator as a ghost, without waking it', async () => {
  const coordinator = await probe.create()
  await probe.prompt(coordinator, 'I coordinate')
  const worker = await probe.create()
  const set = await probe.command(worker, `/relay ${coordinator}`)
  assert.equal(set.kind, 'success', JSON.stringify(set))
  const before = (await probe.events(coordinator)).length
  await probe.prompt(worker, 'finish the report')
  await new Promise((r) => setTimeout(r, 1200))
  const view = await ui.view(coordinator)
  assert.match(view.inbox[0]?.text ?? '', /mock reply: finish the report/)
  assert.equal(view.inbox[0]?.from.by, 'relay')
  const after = (await probe.events(coordinator)).slice(before)
  assert.ok(!after.some((e) => e.type === 'turn/start'), 'the coordinator was not woken')
  await probe.prompt(worker, 'second answer')
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal((await ui.view(coordinator)).inbox.length, 2, 'one ghost per final answer')
  assert.equal((await probe.command(worker, '/relay off')).kind, 'success')
  await probe.prompt(worker, 'third answer')
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal((await ui.view(coordinator)).inbox.length, 2, 'nothing after /relay off')
})

test('custom handoff template: per chat sections reach the handoff request', async () => {
  const sessionId = await seeded()
  const set = await ui.post(`/conductor/session/${sessionId}/template`, { template: '# Handoff\n## Customers\n- [who]\n## Deploy state\n- [what]' })
  assert.equal(set.ok, true, JSON.stringify(set))
  await mock.reset()
  assert.equal((await probe.command(sessionId, '/new')).kind, 'success')
  const handoffCall = (await mock.log()).find((r) => /CONDUCTOR-HANDOFF/.test(allText(r)))
  assert.match(allText(handoffCall), /## Customers[\s\S]*## Deploy state/)
  assert.doesNotMatch(allText(handoffCall), /## 7\. Gotchas/)
})

test('scheduled /new: every N turns runs a handoff by itself when the chat goes idle', async () => {
  const sessionId = await probe.create()
  const set = await probe.command(sessionId, '/auto new turns 2')
  assert.equal(set.kind, 'success', JSON.stringify(set))
  await probe.prompt(sessionId, 'first [[big 3000]]')
  assert.equal((await ui.view(sessionId)).epochs.length, 0)
  await probe.prompt(sessionId, 'second [[big 3000]]')
  let view
  for (let i = 0; i < 30; i += 1) {
    view = await ui.view(sessionId)
    if (view.epochs.length) break
    await new Promise((r) => setTimeout(r, 300))
  }
  assert.equal(view.epochs[0]?.kind, 'new', JSON.stringify(view.epochs))
  assert.equal(view.epochs[0]?.by, 'schedule')
  assert.match((await probe.command(sessionId, '/auto')).text, /every 2 turns/)
})

test('checkpoints: /rewind takes the chat and the agent\'s file edits back, /rewind undo restores the files', async () => {
  const dir = `/tmp/lab-cp-${Date.now()}`
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  const sessionId = await call(`${PROBE}/create`, { method: 'POST', body: { cwd: dir } }).then((r) => { created.push(r.sessionId); return r.sessionId })
  await probe.prompt(sessionId, `create the file [[tool:write {"file_path":"${dir}/a.txt","content":"version one"}]]`)
  assert.equal(readFileSync(`${dir}/a.txt`, 'utf8'), 'version one')
  await probe.prompt(sessionId, `change it [[tool:read {"file_path":"${dir}/a.txt"}]] [[tool:write {"file_path":"${dir}/a.txt","content":"version two"}]] [[tool:write {"file_path":"${dir}/b.txt","content":"new file"}]]`)
  assert.equal(readFileSync(`${dir}/a.txt`, 'utf8'), 'version two')
  assert.ok(existsSync(`${dir}/b.txt`))
  const list = await probe.command(sessionId, '/rewind')
  assert.match(list.text, /1\. .*before "change it/)
  const r = await probe.command(sessionId, '/rewind 1')
  assert.equal(r.kind, 'success', JSON.stringify(r))
  assert.match(r.text, /Restored 2 files/)
  assert.equal(readFileSync(`${dir}/a.txt`, 'utf8'), 'version one')
  assert.equal(existsSync(`${dir}/b.txt`), false)
  await mock.reset()
  await probe.prompt(sessionId, 'where are we')
  const text = allText(turnRequests(await mock.log()).at(-1))
  assert.match(text, /rewound this chat to the checkpoint before "change it/)
  assert.doesNotMatch(text, /version two/)
  const undo = await probe.command(sessionId, '/rewind undo')
  assert.equal(undo.kind, 'success', JSON.stringify(undo))
  assert.equal(readFileSync(`${dir}/a.txt`, 'utf8'), 'version two')
  assert.equal(readFileSync(`${dir}/b.txt`, 'utf8'), 'new file')
})

test('checkpoints: a named /checkpoint and --branch into a new chat', async () => {
  const sessionId = await seeded()
  assert.equal((await probe.command(sessionId, '/checkpoint before experiment')).kind, 'success')
  await probe.prompt(sessionId, 'risky experiment [[big 2000]]')
  const r = await ui.post(`/conductor/session/${sessionId}/rewind`, { target: 'before experiment', branch: true, files: false })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(r.newChat && r.newChat !== sessionId)
  created.push(r.newChat)
  const branch = await probe.state(r.newChat)
  assert.ok(!branch.nodes.some((n) => /risky experiment/.test(n.text)), 'the branch stops at the checkpoint')
  assert.ok((await probe.state(sessionId)).nodes.some((n) => /risky experiment/.test(n.text)), 'the original chat is unchanged')
})

test('automatic level: a chat set to hand off at a low level does so by itself, with a heads-up first', async () => {
  const sessionId = await probe.create()
  const set = await probe.command(sessionId, '/auto level 10 handoff')
  assert.equal(set.kind, 'success', JSON.stringify(set))
  await mock.reset()
  for (let i = 0; i < 6; i += 1) await probe.prompt(sessionId, `part ${i} [[big 12000]]`)
  const view = await ui.view(sessionId)
  const auto = view.epochs.find((e) => e.by === 'auto')
  assert.ok(auto, `an automatic handoff ran: ${JSON.stringify(view.epochs)}`)
  assert.equal(auto.kind, 'new')
  assert.ok(view.activity.some((a) => /Heads-up sent to the model/.test(a.text)), 'heads-up before the level')
  const log = await mock.log()
  assert.ok(log.some((r) => /CONDUCTOR-HANDOFF/.test(allText(r))), 'the level wrote a handoff, not a summary')
  assert.equal((await probe.command(sessionId, '/auto pause')).kind, 'success')
  assert.equal((await ui.view(sessionId)).level.paused, true)
})

test('recovery: a failed turn resumes by itself after backoff', async () => {
  const sessionId = await probe.create()
  await mock.reset()
  await probe.prompt(sessionId, `flaky provider ${Date.now()} [[fail 503 2]]`)
  let view
  for (let i = 0; i < 40; i += 1) {
    view = await ui.view(sessionId)
    if (view.activity.some((a) => /Recovered/.test(a.text))) break
    await new Promise((r) => setTimeout(r, 300))
  }
  assert.ok(view.activity.some((a) => /retry after a provider error/i.test(a.text)), JSON.stringify(view.activity.slice(0, 4)))
  assert.ok(view.activity.some((a) => /Recovered/.test(a.text)), 'the resumed turn completed')
  const events = await probe.events(sessionId)
  assert.ok(events.some((e) => e.type === 'user/message' && /failed because of a provider error/.test(e.text)), 'resume message sent')
})

test('recovery: a permanent failure stops at once with a ghost, nothing is retried', async () => {
  const sessionId = await probe.create()
  await mock.reset()
  await probe.prompt(sessionId, `out of credit ${Date.now()} [[fail 402 99]]`)
  await new Promise((r) => setTimeout(r, 1500))
  const view = await ui.view(sessionId)
  assert.ok(view.activity.some((a) => /Stopped: the provider quota or balance is exhausted/.test(a.text)), JSON.stringify(view.activity.slice(0, 4)))
  assert.match(view.inbox[0]?.text ?? '', /Recovery stopped/)
  const requests = (await mock.log()).filter((r) => /out of credit/.test(allText(r)))
  assert.ok(requests.length <= 2, `only DSH's own retry, no recovery resends (${requests.length})`)
})

test('recovery: a cut-off answer continues where it stopped', async () => {
  const sessionId = await probe.create()
  await probe.prompt(sessionId, 'long answer [[truncate]]')
  let events
  for (let i = 0; i < 30; i += 1) {
    events = await probe.events(sessionId)
    if (events.some((e) => e.type === 'user/message' && /cut off at the output limit/.test(e.text))) break
    await new Promise((r) => setTimeout(r, 300))
  }
  const turnEnd = events.find((e) => e.type === 'turn/end')
  if (turnEnd && !/max-tokens/.test(JSON.stringify(turnEnd))) {
    // this DSH build continues truncated steps itself; nothing for Recovery to do
    return
  }
  assert.ok(events.some((e) => e.type === 'user/message' && /cut off at the output limit/.test(e.text)), 'continue message sent')
})

test('every chat these tests touched reloads from disk (stored-log format and surface validation)', async () => {
  assert.ok(created.length >= 10)
  const failures = []
  for (const sessionId of created) {
    const result = await probe.verify(sessionId)
    if (!result.ok) failures.push(`${sessionId}: ${result.error}`)
  }
  assert.deepEqual(failures, [])
})
