/**
 * Contract test against the INSTALLED DSH core: the browser half relies on a
 * few client seams that are not a stable public API yet. This test reads the
 * core packages on disk and fails when one of those seams moves, so a DSH
 * upgrade breaks a test instead of silently degrading the UI.
 *
 * Core location, first hit wins:
 *   DSH_CORE_DIR                      the @deepseek-ai directory itself
 *   the dsh binary on PATH            <install>/node_modules/@deepseek-ai
 *   ~/.nvm/.../@deepseek-ai/dsh/...   the usual global install
 * Without a core install every test is skipped with the reason.
 *
 * Run: node --test test/contract.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, sep } from 'node:path'

function fromPath() {
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const bin = join(dir, 'dsh')
    if (!existsSync(bin)) continue
    try {
      const real = realpathSync(bin)
      const at = real.indexOf(sep + 'lib' + sep + 'bin.js')
      const root = at > 0 ? real.slice(0, at) : dirname(dirname(real))
      return join(root, 'node_modules', '@deepseek-ai')
    } catch { /* next */ }
  }
  return null
}

function coreDir() {
  const candidates = [
    process.env.DSH_CORE_DIR,
    fromPath(),
    join(homedir(), '.nvm/versions/node', process.version, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
  ].filter(Boolean)
  return candidates.find((c) => existsSync(join(c, 'dsh-client-ui-chat'))) || null
}

const CORE = coreDir()
const skip = CORE ? false : 'DSH core not installed here (set DSH_CORE_DIR to its @deepseek-ai directory to run the contract test)'
if (!CORE) console.log('contract.mjs: SKIP - ' + skip)

const read = (rel) => {
  const file = join(CORE, rel)
  assert.ok(existsSync(file), 'missing core file ' + rel)
  return readFileSync(file, 'utf8')
}
/** Source text of the registration that names `key` in `slot` (the object literal after ctx.slots.register). */
function registration(src, slot, key) {
  const re = new RegExp('name:\\s*"' + slot.replace(/\./g, '\\.') + '",\\s*key:\\s*"' + key + '"([\\s\\S]{0,600}?)\\}, \\w+\\)\\)', 'm')
  const m = src.match(re)
  return m ? m[0] : null
}

test('core: conversation.chat.node is a keyed session slot and the built-in user and assistant-step renderers are registered', { skip }, () => {
  const slots = read('dsh-client-ui-chat/lib/types/client/contract/slots.d.ts')
  const node = slots.slice(slots.indexOf("'conversation.chat.node': {"))
  assert.ok(slots.includes("'conversation.chat.node': {"), 'slot declared')
  assert.match(node.slice(0, 200), /kind: 'keyed';/)
  assert.match(node.slice(0, 200), /scope: 'session';/)
  const chat = read('dsh-client-ui-chat/lib/client.js')
  assert.ok(registration(chat, 'conversation.chat.node', 'user'), "built-in 'user' renderer")
  const asst = registration(chat, 'conversation.chat.node', 'assistant-step')
  assert.ok(asst, "built-in 'assistant-step' renderer")
  // the child slots our shadow serves itself (it may not declare them twice)
  assert.match(asst, /"conversation\.chat\.reasoning\.body"/)
  assert.match(asst, /"conversation\.chat\.message\.images"/)
  // the Factories behind them, which useChildSlots calls directly
  assert.match(chat, /name: "conversation\.chat\.reasoning\.content"/)
  assert.match(read('dsh-client-ui-attachment/lib/client.js'), /renderFactorySlot\("conversation\.images\.content"/)
})

test('core: keyed cells render the winner of their key and later registrations get a lower priority', { skip }, () => {
  const renderer = read('dsh-client-ui-renderer/lib/client.js')
  assert.match(renderer, /entriesOfSlot\(slotKey\)\.find\(\(e\) => e\.options\.key === opts\?\.entryKey\)/, 'a keyed outlet renders the winner of its key')
  const runner = read('dsh-cordis-client-runner/lib/client.js')
  assert.match(runner, /A later registration receives a lower priority/)
})

test('core: node data shapes the shadow rewrites', { skip }, () => {
  const nodes = read('dsh-client-ui-chat/lib/types/client/contract/chat-nodes.d.ts')
  assert.match(nodes, /readonly blocks: readonly AssistantBlock\[\];/)
  assert.match(nodes, /readonly finalNode\?: AssistantMessageNode;/)
  const records = read('dsh-client-ui-conversation/lib/types/client/contract/records.d.ts')
  assert.match(records, /export interface AssistantMessageNode \{[\s\S]*?messageId\?: MessageId;/)
  assert.match(records, /kind: 'text';\s*text: string;/)
  const chat = read('dsh-client-ui-chat/lib/client.js')
  assert.match(chat, /kind: "user",\s*seq: event\.seq,\s*time: event\.time,\s*content: event\.data\.content/, "user nodes carry data.seq and data.content")
})

test('core: conversation.chat.assistant-actions is a list slot with messageId owner props', { skip }, () => {
  const slots = read('dsh-client-ui-chat/lib/types/client/contract/slots.d.ts')
  assert.ok(slots.includes("'conversation.chat.assistant-actions': {"))
  assert.match(slots, /export interface AssistantActionOwnerProps \{\s*messageId: MessageId;/)
  assert.match(read('dsh-client-ui-chat/lib/client.js'), /renderSlot\("conversation\.chat\.assistant-actions", \{ messageId \}\)/)
})

test('core: uiConversation event Definitions can claim an event exclusively for the chat target', { skip }, () => {
  const conv = read('dsh-client-ui-conversation/lib/client.js')
  assert.match(conv, /if \(results\[index\]\.exclusive !== true\) continue;/, 'exclusive claims')
  assert.match(conv, /if \(target !== void 0 && result\.exclusive !== true && claims\?\.has\(target\) === true\) continue;/, 'a claim silences the other Definitions of that target')
  const chat = read('dsh-client-ui-chat/lib/client.js')
  assert.match(chat, /ctx\.uiConversation\.events\.register\(messageDefinition\)/, 'Chat still registers its message Definition through the same API')
  assert.match(chat, /return isSurfaceEvent\(event\) && event\.surfaceOp === "append";/, 'append-origin events are still marked surfaceOp "append"')
})

test('core: commandUi.register and commandUi.decorate exist', { skip }, () => {
  const contract = read('dsh-client-ui-commands/lib/types/client/contract.d.ts')
  assert.match(contract, /register\(contribution: CommandContribution\): \(\) => void;/)
  assert.match(contract, /decorate\(decoration: CommandDecoration\): \(\) => void;/)
  assert.match(contract, /available\(session: ClientSessionContext\): boolean;/)
})
