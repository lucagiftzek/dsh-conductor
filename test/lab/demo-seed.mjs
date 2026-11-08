#!/usr/bin/env node
/**
 * Seed the demo instance (test/lab/demo.sh start) with believable chats: the
 * release chat with a plan, a review, two file edits and a summary, plus a
 * few side chats so the chat list looks natural. Every prompt is a key of
 * test/lab/demo-replies.json, so no test marker shows anywhere.
 * Writes the chat ids to $LAB_HOME/run/demo-sessions.json.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.LAB_HOME || '/tmp/dsh-demo'
const API = 'http://127.0.0.1:3193/lab-probe/api'
const headers = { 'x-lab-token': 'lab', 'content-type': 'application/json' }
const table = JSON.parse(readFileSync(process.env.MOCK_DEMO_FILE || join(HERE, 'demo-replies.json'), 'utf8'))

async function call(path, body) {
  const res = await fetch(API + path, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}
async function chat(prompts) {
  const { sessionId } = await call('/create', { cwd: '/tmp/demo-app' })
  for (const text of prompts) {
    if (!table[text]) throw new Error('not a demo prompt: ' + text)
    await call('/prompt', { sessionId, text, timeoutMs: 60000 })
  }
  return sessionId
}

const ids = {}
// side chats first, so the release chat is the newest in the list
ids.support = await chat(['Summarise last week\'s support tickets about invoices'])
ids.migration = await chat(['Draft the migration note for the rounding setting'])
ids.flaky = await chat(['Find out why the checkout test fails one run in twenty'])
ids.docs = await chat(['Refresh the API docs for the invoice endpoints'])
ids.coordinator = await chat(['Watch CI and the staging checks for the billing service'])
ids.release = await chat([
  'Plan the 0.4 release of the billing service',
  'Review the rounding change in src/invoice.ts',
  'Add a retry with backoff to the payment client',
  'Update the changelog for 0.4',
  'What is left before we tag 0.4?',
])
writeFileSync(join(HOME, 'run', 'demo-sessions.json'), JSON.stringify(ids, null, 2))
console.log(JSON.stringify(ids, null, 2))
