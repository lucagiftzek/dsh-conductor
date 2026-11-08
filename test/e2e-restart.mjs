#!/usr/bin/env node
/**
 * End to end, across a restart of the LAB instance (never the live dsh-web):
 * every per-chat setting and the checkpoints survive, and file checkpoints
 * still restore after the restart. Run after test/e2e.mjs; it restarts the lab
 * through test/lab/lab.sh.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { harnessCookieName } from '../lib/security.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LAB = process.env.LAB_URL || 'http://127.0.0.1:3193'
const PROBE = `${LAB}/lab-probe/api`
const API = `${LAB}/dsh-conductor/api`
const H = { 'x-lab-token': process.env.LAB_PROBE_TOKEN || 'lab', 'content-type': 'application/json' }
const UI = { host: new URL(LAB).host, 'content-type': 'application/json', 'x-requested-with': 'dsh-conductor', origin: LAB, 'sec-fetch-site': 'same-origin', cookie: `${harnessCookieName(new URL(LAB).host)}=lab` }

async function call(url, { method = 'GET', body, headers = H } = {}) {
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  try { return { status: res.status, ...JSON.parse(text) } } catch { return { status: res.status, raw: text } }
}
const prompt = (sessionId, text) => call(`${PROBE}/prompt`, { method: 'POST', body: { sessionId, text } })
const command = (sessionId, line) => call(`${PROBE}/command`, { method: 'POST', body: { sessionId, line } }).then((r) => r.result)
const view = (sessionId) => call(`${API}/conductor/session/${sessionId}`, { headers: UI })
const post = (path, body) => call(`${API}${path}`, { method: 'POST', body, headers: UI })

test('per-chat settings, checkpoints and file rewind survive a restart', async () => {
  const dir = `/tmp/lab-restart-${Date.now()}`
  mkdirSync(dir, { recursive: true })
  const coordinator = (await call(`${PROBE}/create`, { method: 'POST', body: { cwd: '/tmp' } })).sessionId
  await prompt(coordinator, 'I coordinate')
  const sessionId = (await call(`${PROBE}/create`, { method: 'POST', body: { cwd: dir } })).sessionId
  await prompt(sessionId, `make it [[tool:write {"file_path":"${dir}/x.txt","content":"first"}]]`)
  await prompt(sessionId, `change it [[tool:read {"file_path":"${dir}/x.txt"}]] [[tool:write {"file_path":"${dir}/x.txt","content":"second"}]]`)
  assert.equal((await command(sessionId, '/auto level 60 handoff')).kind, 'success')
  assert.equal((await command(sessionId, '/auto new daily 04:30')).kind, 'success')
  assert.equal((await command(sessionId, `/relay ${coordinator}`)).kind, 'success')
  assert.equal((await command(sessionId, '/checkpoint before restart')).kind, 'success')
  assert.equal((await command(sessionId, '/recovery off')).kind, 'success')
  assert.equal((await post(`/conductor/session/${sessionId}/template`, { template: '# Handoff\n## Customers\n- [who]' })).ok, true)
  assert.equal((await command(sessionId, '/pin user')).kind, 'success')
  const before = await view(sessionId)

  execFileSync(join(HERE, 'lab', 'lab.sh'), ['restart'], { stdio: 'ignore', timeout: 120000 })

  const after = await view(sessionId)
  assert.equal(after.ok, true, JSON.stringify(after).slice(0, 300))
  assert.deepEqual({ percent: after.level.percent, action: after.level.action, source: after.level.source }, { percent: 60, action: 'handoff', source: 'chat' })
  assert.equal(after.autoNew?.daily, '04:30')
  assert.equal(after.relay?.to, coordinator)
  assert.equal(after.handoffTemplate, '# Handoff\n## Customers\n- [who]')
  assert.equal(after.recovery?.chatDisabled, true)
  assert.equal(after.pins.length, before.pins.length)
  assert.equal(after.checkpoints.length, before.checkpoints.length)
  assert.ok(after.checkpoints.some((c) => c.name === 'before restart'))
  // the file checkpoints still work after the restart
  const turn = after.checkpoints.find((c) => /^change it/.test(c.label))
  const r = await post(`/conductor/session/${sessionId}/rewind`, { target: turn.id, chat: false })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(readFileSync(`${dir}/x.txt`, 'utf8'), 'first')
  writeFileSync(`${dir}/.done`, '')
})
