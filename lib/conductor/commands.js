/**
 * Slash commands. Each one is a thin parser over the Conductor service, so
 * the sidebar, the model tools and the composer always behave the same.
 */
import { fmtTokens } from './service.js'
import { parseAutoNew, describeAutoNew } from './automation.js'

export const USAGE = {
  new: [
    'Usage: /new [focus notes]',
    '  Start fresh in this same chat: the model writes a handoff from the full conversation,',
    '  and the handoff (plus your pins) becomes the whole history. Same chat, same title, same id.',
    '  The full transcript is archived and stays visible above.',
  ].join('\n'),
  clear: 'Usage: /clear\n  Empty the model context of this chat (no summary). Pins are kept; the transcript stays visible and archived.',
  'force-compact': [
    'Usage: /force-compact [--pointer] [focus notes]',
    '  /force-compact            summarize the whole history in parts that fit the model, merge them, archive the verbatim text',
    '  /force-compact <notes>    same, telling the summarizer what to keep',
    '  /force-compact --pointer  no model call: mechanical checkpoint (your requests + last answer) plus the archive pointer',
  ].join('\n'),
  drop: [
    'Usage: /drop <what>    remove items from the model context (the chat transcript keeps them)',
    '  /drop last [n]              the n most recent tool outputs (default 1)',
    '  /drop tool <name> [keep n]  every output of one tool, optionally keeping the newest n',
    '  /drop file <text>           tool outputs whose call mentions <text> (a path, a URL)',
    '  /drop larger <size>         tool outputs above a size, e.g. 10K',
    '  /drop <seq> [<seq> ...]     exact items (the numbers shown by /context)',
    '  /undrop [last|all|<id>]     put dropped items back',
  ].join('\n'),
  pin: 'Usage: /pin [note]          pin the last answer (kept across /new and /clear)\n       /pin user [note]     pin your last message\n       /pin <message id> [note]',
  unpin: 'Usage: /unpin [last|<pin id>|<message id>]',
  recall: 'Usage: /recall <words or "exact phrase">\n  Search this chat\'s earlier epochs (archives of every /new, /clear and compaction, dropped items, handoffs) and show the best passages with file and line.',
  relay: 'Usage: /relay <chat>   every final answer of this chat arrives there as a ghost (silent)\n       /relay off      stop\n       /relay          show the current target',
  checkpoint: 'Usage: /checkpoint [name]   mark this point; /rewind <name> comes back to it (chat and the agent\'s file edits)',
  rewind: [
    'Usage: /rewind                       list the checkpoints (newest first)',
    '       /rewind <n|name|id>           back to that checkpoint: conversation and files',
    '       /rewind last                  undo the last prompt (conversation and files)',
    '       add --chat or --files         only one of the two',
    '       add --branch                  continue from there in a NEW chat, this one unchanged',
    '       add --force                   also overwrite files changed outside the agent since',
    '       /rewind undo                  put back the files the last rewind restored',
  ].join('\n'),
  recovery: 'Usage: /recovery            status for this chat\n       /recovery on | off   resume automatically after failed or cut-off turns, or wait for you',
  auto: 'Usage: /auto                     show this chat\'s automation\n       /auto level 50             compact by itself at 50% of the model window\n       /auto level 50 handoff     hand off to a fresh context at 50% instead (like /new)\n       /auto level default        back to the global level\n       /auto pause | resume       stop or restart the automatic level and heads-up for this chat\n       /auto new daily 03:00      run /new every day at that time\n       /auto new turns 40         run /new every 40 turns\n       /auto new off              stop the scheduled /new',
  post: 'Usage: /post <chat> <text>\n  Silent message into another chat: it is shown there and read by its model on its next turn, without waking it.\n  <chat> is an id, a unique id prefix, or an exact title in quotes: /post "Coordinator" report is ready',
}

export function parseFocus(raw) {
  const text = String(raw ?? '').trim()
  if (/^(-h|--help|help)$/i.test(text)) return { help: true }
  return { focus: text ? text.slice(0, 2000) : undefined }
}

export function parseForceCompact(raw) {
  const text = String(raw ?? '').trim()
  if (/^(-h|--help|help)$/i.test(text)) return { help: true }
  const pointer = /(^|\s)(--pointer|--no-llm|pointer)(?=\s|$)/i.test(text)
  const focus = text.replace(/(^|\s)(--pointer|--no-llm|pointer)(?=\s|$)/gi, ' ').trim()
  return { kind: pointer ? 'pointer' : 'force-compact', focus: focus.length > 0 ? focus.slice(0, 2000) : undefined }
}

function parseSize(value) {
  const m = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/)
  if (!m) return NaN
  return Number(m[1]) * (m[2].toLowerCase() === 'k' ? 1000 : m[2].toLowerCase() === 'm' ? 1000000 : 1)
}

/** @returns {{ help?: true, error?: string, selector?: object }} */
export function parseDrop(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { empty: true }
  if (/^(-h|--help|help)$/i.test(text)) return { help: true }
  const words = text.split(/\s+/)
  const head = words[0].toLowerCase()
  if (head === 'last') {
    const n = words[1] === undefined ? 1 : Number(words[1])
    if (!Number.isInteger(n) || n < 1 || n > 500) return { error: '/drop last needs a count between 1 and 500' }
    return { selector: { last: n } }
  }
  if (head === 'tool') {
    if (!words[1]) return { error: '/drop tool needs a tool name' }
    const keepAt = words.findIndex((w) => w.toLowerCase() === 'keep')
    const keep = keepAt > 0 ? Number(words[keepAt + 1]) : 0
    if (keepAt > 0 && (!Number.isInteger(keep) || keep < 0)) return { error: 'keep needs a whole number' }
    return { selector: { tool: words[1], keepNewest: keep } }
  }
  if (head === 'file') {
    const needle = text.slice(4).trim()
    if (!needle) return { error: '/drop file needs part of a path or URL' }
    return { selector: { file: needle } }
  }
  if (head === 'larger' || head === '>') {
    const size = parseSize(words[1])
    if (!Number.isFinite(size) || size <= 0) return { error: '/drop larger needs a size like 8K' }
    return { selector: { larger: size } }
  }
  const seqs = words.map((w) => Number(w.replace(/^#/, '')))
  if (seqs.every((n) => Number.isInteger(n) && n >= 0)) return { selector: { seqs } }
  return { error: `I do not understand "${text.slice(0, 60)}".` }
}

/** /post <target> <text>, the target either quoted or a single word. */
export function parsePost(raw) {
  const text = String(raw ?? '').trim()
  if (!text || /^(-h|--help|help)$/i.test(text)) return { help: true }
  const quoted = text.match(/^"([^"]+)"\s+([\s\S]+)$/) ?? text.match(/^'([^']+)'\s+([\s\S]+)$/)
  if (quoted) return { to: quoted[1].trim(), text: quoted[2].trim() }
  const m = text.match(/^(\S+)\s+([\s\S]+)$/)
  if (!m) return { error: 'a message text is required after the chat' }
  return { to: m[1], text: m[2].trim() }
}

export function parseLevel(words) {
  const [value, action] = words
  if (!value) return { error: 'say a percentage (10 to 95), "default" or "off"' }
  if (/^(default|off)$/i.test(value)) return { off: true }
  const percent = Number(String(value).replace(/%$/, ''))
  if (!Number.isFinite(percent) || percent < 10 || percent > 95) return { error: 'the level must be between 10 and 95 percent' }
  if (action && !/^(compact|handoff|new)$/i.test(action)) return { error: 'the action is compact or handoff' }
  return { percent, ...(action ? { action: /^compact$/i.test(action) ? 'compact' : 'handoff' } : {}) }
}

export function describeLevelLine(level) {
  if (level.paused) return 'Automatic level: paused for this chat (DSH default applies).'
  if (!level.percent) return 'Automatic level: DSH default (about 80%).'
  return `Automatic level: ${level.action === 'handoff' ? 'handoff' : 'compact'} at ${level.percent}% (${level.source === 'chat' ? 'this chat' : 'all chats'}).`
}

export function contextSummary(view, limit = 12) {
  const { meter, items } = view
  const pct = meter.window ? Math.round((meter.total / meter.window) * 100) : null
  const lines = [`Context: ${fmtTokens(meter.total)} tokens${meter.window ? ` of ${fmtTokens(meter.window)} (${pct}%)` : ''}.`]
  const cats = Object.entries(meter.categories).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  lines.push(cats.map(([k, v]) => `${k} ${fmtTokens(v)}`).join(', '))
  const top = [...items].filter((i) => i.droppable).sort((a, b) => b.tokens - a.tokens).slice(0, limit)
  if (top.length) {
    lines.push('', `Largest items you can drop (/drop <seq>):`)
    for (const item of top) lines.push(`  ${String(item.seq).padStart(5)}  ${fmtTokens(item.tokens).padStart(6)}  ${item.category.padEnd(9)} ${item.label.slice(0, 70)}`)
  }
  return lines.join('\n')
}

/**
 * Register every command. Returns the names that could not be registered
 * (taken by another plugin, e.g. a still-mounted dsh-force-compact).
 */
export function registerCommands(ctx, conductor, { log = () => {}, warn = () => {}, enabled = () => true } = {}) {
  const ok = (text) => ({ kind: 'success', text })
  const fail = (text) => ({ kind: 'error', text })
  const guard = (fn) => async (invocation) => {
    try {
      return await fn(invocation)
    } catch (error) {
      return fail(String(error?.message || error))
    }
  }
  const sid = (inv) => inv.agent.session.id

  const defs = [
    {
      name: 'new',
      description: 'Start fresh in this chat: a handoff replaces the history (same chat, pins kept, archive saved)',
      input: { hint: '[focus notes]' },
      handler: guard(async (inv) => {
        const args = parseFocus(inv.rawInput)
        if (args.help) return ok(USAGE.new)
        const result = await conductor.reset(inv.agent, 'new', { focus: args.focus, by: 'user', commandId: inv.commandId, signal: inv.signal })
        return result.ok ? ok(result.text) : fail(result.text)
      }),
    },
    {
      name: 'clear',
      description: 'Empty the model context of this chat (pins kept, transcript archived)',
      handler: guard(async (inv) => {
        if (/^(-h|--help|help)$/i.test(String(inv.rawInput ?? '').trim())) return ok(USAGE.clear)
        const result = await conductor.reset(inv.agent, 'clear', { by: 'user', commandId: inv.commandId, signal: inv.signal })
        return result.ok ? ok(result.text) : fail(result.text)
      }),
    },
    {
      name: 'force-compact',
      description: 'Compact even when the history no longer fits the model: summarize in parts, archive the verbatim text, keep a pointer',
      input: { hint: '[--pointer] [focus notes]' },
      handler: guard(async (inv) => {
        const args = parseForceCompact(inv.rawInput)
        if (args.help) return ok(USAGE['force-compact'])
        const result = await conductor.reset(inv.agent, args.kind, { focus: args.focus, by: 'user', commandId: inv.commandId, signal: inv.signal })
        return result.ok ? ok(result.text) : fail(`${result.text}${args.kind === 'pointer' ? '' : ' If the model keeps failing, try /force-compact --pointer (no model call).'}`)
      }),
    },
    {
      name: 'context',
      description: 'Show what fills the model context, largest items first',
      handler: guard(async (inv) => {
        const view = await conductor.view(sid(inv))
        return ok(contextSummary(view))
      }),
    },
    {
      name: 'drop',
      description: 'Remove items from the model context (the transcript keeps them)',
      input: { hint: 'last [n] | tool <name> [keep n] | file <text> | larger <size> | <seq>...' },
      handler: guard(async (inv) => {
        const args = parseDrop(inv.rawInput)
        if (args.help) return ok(USAGE.drop)
        if (args.empty) return ok(`${USAGE.drop}\n\n${contextSummary(await conductor.view(sid(inv)), 8)}`)
        if (args.error) return fail(`${args.error}\n${USAGE.drop}`)
        const result = await conductor.drop(sid(inv), args.selector, { by: 'user' })
        return result.ok ? ok(`${result.text}${result.undoable?.length ? ' Undo with /undrop.' : ''}`) : fail(result.text)
      }),
    },
    {
      name: 'undrop',
      description: 'Put dropped items back into the model context',
      input: { hint: '[last|all|<id>]' },
      handler: guard(async (inv) => {
        const target = String(inv.rawInput ?? '').trim() || 'last'
        const result = await conductor.undrop(sid(inv), target, { by: 'user' })
        return result.ok ? ok(result.text) : fail(result.text)
      }),
    },
    {
      name: 'pin',
      description: 'Pin the last answer (or "user" for your last message) so it survives /new and /clear',
      input: { hint: '[user] [note]' },
      handler: guard(async (inv) => {
        const raw = String(inv.rawInput ?? '').trim()
        if (/^(-h|--help|help)$/i.test(raw)) return ok(USAGE.pin)
        let target = 'last'
        let note = raw
        const first = raw.split(/\s+/)[0] ?? ''
        if (/^user$/i.test(first)) { target = 'last-user'; note = raw.slice(first.length).trim() }
        else if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(first) || /^\d+$/.test(first)) { target = first; note = raw.slice(first.length).trim() }
        const result = await conductor.pin(sid(inv), target, { note: note || undefined, by: 'user' })
        return ok(result.text)
      }),
    },
    {
      name: 'unpin',
      description: 'Remove a pin (the last one by default)',
      input: { hint: '[last|<pin id>|<message id>]' },
      handler: guard(async (inv) => {
        const result = conductor.unpin(sid(inv), String(inv.rawInput ?? '').trim() || 'last', { by: 'user' })
        return result.ok ? ok(result.text) : fail(result.text)
      }),
    },
    {
      name: 'recall',
      description: 'Search this chat\'s earlier epochs (archives, dropped items, handoffs)',
      input: { hint: '<words or "exact phrase">' },
      handler: guard(async (inv) => {
        const q = String(inv.rawInput ?? '').trim()
        if (!q || /^(-h|--help|help)$/i.test(q)) return ok(USAGE.recall)
        return ok(conductor.recallFor(sid(inv), q, { limit: 5 }).text)
      }),
    },
    {
      name: 'relay',
      description: 'Send every final answer of this chat to another chat as a ghost',
      input: { hint: '<chat> | off' },
      handler: guard(async (inv) => {
        const raw = String(inv.rawInput ?? '').trim()
        if (/^(-h|--help|help)$/i.test(raw)) return ok(USAGE.relay)
        if (!raw) {
          const relay = conductor.store.get(sid(inv)).relay
          return ok(relay ? `Final answers go to "${relay.label}" as ghosts. /relay off stops it.` : `No relay. ${USAGE.relay}`)
        }
        const target = raw.replace(/^"(.*)"$/, '$1')
        const result = await conductor.setRelay(sid(inv), target, { by: 'user' })
        return ok(result.text)
      }),
    },
    {
      name: 'checkpoint',
      description: 'Mark this point to come back to with /rewind',
      input: { hint: '[name]' },
      handler: guard(async (inv) => {
        if (!conductor.checkpoints) return fail('checkpoints are not available')
        const raw = String(inv.rawInput ?? '').trim().replace(/^"(.*)"$/, '$1')
        if (/^(-h|--help|help)$/i.test(raw)) return ok(USAGE.checkpoint)
        return ok(conductor.checkpoints.mark(sid(inv), raw || undefined, { by: 'user' }).text)
      }),
    },
    {
      name: 'rewind',
      description: 'Go back to a checkpoint: conversation and the agent\'s file edits',
      input: { hint: '[n|name|last] [--chat|--files] [--branch] [--force] | undo' },
      handler: guard(async (inv) => {
        const cps = conductor.checkpoints
        if (!cps) return fail('checkpoints are not available')
        const raw = String(inv.rawInput ?? '').trim()
        if (/^(-h|--help|help)$/i.test(raw)) return ok(USAGE.rewind)
        if (/^undo$/i.test(raw)) { const r = cps.undoRestore(sid(inv), { by: 'user' }); return r.ok ? ok(r.text) : fail(r.text) }
        if (!raw) {
          const list = cps.list(sid(inv)).slice(0, 12)
          if (!list.length) return ok('No checkpoints yet: one is made at the start of every prompt. ' + USAGE.checkpoint)
          return ok(['Checkpoints, newest first (/rewind <n>):', ...list.map((c, i) => `  ${String(i + 1).padStart(2)}. ${c.at.slice(0, 16).replace('T', ' ')}  ${c.kind === 'manual' ? 'checkpoint' : c.auto ? 'automatic' : 'before'} "${(c.name ?? c.label ?? '').slice(0, 70)}"${c.files ? `  (${c.files} file${c.files === 1 ? '' : 's'} edited after)` : ''}`), '', USAGE.rewind].join('\n'))
        }
        const flags = new Set((raw.match(/--[a-z]+/g) ?? []).map((f) => f.slice(2)))
        const target = raw.replace(/--[a-z]+/g, '').trim().replace(/^"(.*)"$/, '$1') || 'last'
        const only = flags.has('chat') ? 'chat' : flags.has('files') ? 'files' : null
        const r = await cps.rewind(sid(inv), target, { chat: only !== 'files', files: only !== 'chat', branch: flags.has('branch'), force: flags.has('force'), by: 'user' })
        return ok(`${r.text}${r.prompt ? `\nThe prompt you rewound: ${r.prompt}` : ''}`)
      }),
    },
    {
      name: 'recovery',
      description: 'Automatic resume after failed, cut-off or crashed turns',
      input: { hint: 'on | off' },
      handler: guard(async (inv) => {
        const rec = conductor.recovery
        if (!rec) return fail('recovery is not available')
        const word = String(inv.rawInput ?? '').trim().toLowerCase()
        if (word === 'on' || word === 'off') return ok(rec.setChat(sid(inv), word === 'on', { by: 'user' }).text)
        if (word && word !== 'status') return ok(USAGE.recovery)
        const st = rec.status(sid(inv))
        if (st.conflict) return ok('Recovery is off because @weibaohui/dsh-continue is still installed. Run scripts/migrate-profile.mjs to replace it.')
        return ok(`Recovery is ${st.enabled ? 'on' : 'off'} for this chat${st.attempts ? ` (attempt ${st.attempts} of ${st.maxAttempts}${st.waiting ? ', waiting to resume' : ''})` : ''}${st.fallback ? `, on the fallback model ${st.fallback}` : ''}.\n${USAGE.recovery}`)
      }),
    },
    {
      name: 'auto',
      description: 'Automation for this chat: scheduled /new',
      input: { hint: 'new daily 03:00 | new turns 40 | new off' },
      handler: guard(async (inv) => {
        const words = String(inv.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        const automation = conductor.automation
        if (!automation) return fail('automation is not available')
        if (words.length === 0) {
          const level = conductor.setLevel ? conductor.effectiveLevel(sid(inv)) : null
          const relay = conductor.store.get(sid(inv)).relay
          return ok([level ? describeLevelLine(level) : null, `${describeAutoNew(conductor.store.get(sid(inv)).autoNew)}.`, relay ? `Final answers relayed to "${relay.label}".` : null, '', USAGE.auto].filter((x) => x !== null).join('\n'))
        }
        if (/^(-h|--help|help)$/i.test(words[0])) return ok(USAGE.auto)
        const head = words[0].toLowerCase()
        if (head === 'pause' || head === 'resume') return ok(conductor.setLevel(sid(inv), { paused: head === 'pause' }, { by: 'user' }).text)
        if (head === 'level') {
          const spec = parseLevel(words.slice(1))
          if (spec.error) return fail(`${spec.error}\n${USAGE.auto}`)
          return ok(conductor.setLevel(sid(inv), spec, { by: 'user' }).text)
        }
        if (head !== 'new') return fail(USAGE.auto)
        const spec = parseAutoNew(words.slice(1))
        if (spec.error) return fail(`${spec.error}\n${USAGE.auto}`)
        return ok(automation.setAutoNew(sid(inv), spec, { by: 'user' }).text)
      }),
    },
    {
      name: 'post',
      description: 'Silent message into another chat (shown there, read on its next turn, does not wake it)',
      input: { hint: '<chat> <text>' },
      handler: guard(async (inv) => {
        const args = parsePost(inv.rawInput)
        if (args.help) return ok(USAGE.post)
        if (args.error) return fail(`${args.error}\n${USAGE.post}`)
        const result = await conductor.post({ to: args.to, text: args.text, fromSessionId: sid(inv), kind: 'note', visible: 'user+model' }, { by: 'user' })
        return ok(result.text)
      }),
    },
  ]

  const skipped = []
  ctx.effect(function* () {
    for (const def of defs) {
      if (!enabled(def.name)) continue
      let dispose
      try {
        dispose = ctx.commands.register(def)
      } catch (error) {
        skipped.push(def.name)
        warn(`/${def.name} not registered: ${String(error?.message || error).slice(0, 160)}`)
        continue
      }
      yield dispose
    }
    log(`commands: ${defs.filter((d) => enabled(d.name) && !skipped.includes(d.name)).map((d) => `/${d.name}`).join(' ')}`)
  }, 'dsh-conductor commands')
  return skipped
}
