/**
 * dsh-conductor: the compaction engine patch (ported from dsh-force-compact,
 * behaviour unchanged, plus the `handoff` and `clear` modes behind /new and
 * /clear).
 *
 * Modes, chosen per session by the service before it calls the agent's own
 * `/compact` handler (compaction-basic keeps locking, events and the surface
 * replacement; this module only decides what the checkpoint says):
 *   (none)     regular compaction: one-shot summary, verbatim archive, pointer
 *   chunked    /force-compact: map-reduce summary that always fits the model
 *   pointer    /force-compact --pointer: mechanical checkpoint, no model call
 *   handoff    /new: the model writes a handoff document from the full
 *              context; the handoff becomes the whole new history
 *   clear      /clear: a short placeholder, no model call
 *
 * Original force-compact notes follow.
 *
 * Makes compaction work when the history no longer fits the model.
 *
 * WHY: @deepseek-ai/dsh-compaction-basic summarizes by replaying the WHOLE
 * selected span plus a "condense the conversation above" instruction in ONE
 * model request. Once a session is past the context window (the usual reason
 * you want to compact), that request is itself too long, so both `/compact`
 * and the automatic context-overflow recovery fail with
 * "Compaction could not produce a useful summary".
 *
 * WHAT: the engine's documented customization hook is `summarize(input, agent,
 * signal)` ("the sole subclass customization hook"). This plugin wraps that
 * method on the engine prototype, so every preset (ptc, ptc-lean, standard,
 * augmentor, ...) is covered without touching the presets:
 *
 *   1. archive: the verbatim span about to be replaced is written to a private
 *      Markdown file and the checkpoint gets a pointer to it, so compaction
 *      becomes lossless (the agent can grep/read the archive later).
 *   2. overflow fallback: when the normal one-shot summary fails with a
 *      context-window error, the span is split into parts that fit, each part
 *      is summarized, and the part summaries are merged (map-reduce).
 *   3. `/force-compact [focus]`: goes straight to the chunked path.
 *      `/force-compact --pointer`: no model call at all; a mechanical
 *      checkpoint (user requests + last answer) plus the archive pointer.
 *
 * The durable mutation (events, surface replace, locking) stays entirely in
 * compaction-basic: `/force-compact` simply sets a per-session mode and calls
 * the agent's own `/compact` handler.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { importCore } from './core-imports.js';

// Shared with dsh-force-compact on purpose: both packages patch the same
// prototype, so a profile that still mounts force-compact never stacks two
// wrappers (the later apply() takes the existing record over).
const PATCH = Symbol.for('dsh-force-compact.patch');
const OVERFLOW_CODE = 'CONTEXT_WINDOW_EXCEEDED';
const OVERFLOW_TEXT = /prompt is too long|context[ _-]?window|context length|maximum context|too many (input )?tokens|exceeds? the (model'?s )?(maximum|max)/i;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export const DEFAULTS = Object.freeze({
  archiveDir: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'compact-archive'),
  handoffDir: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-conductor', 'handoffs'),
  archiveEveryCompaction: true,
  overflowFallback: true,
  chunkWindowRatio: 0.6,
  maxChunkTokens: 300000,
  minChunkTokens: 20000,
  charsPerToken: 3,
  concurrency: 2,
  fallbackContextWindow: 200000,
  defaultSummaryMaxTokens: 65536,
  toolResultChars: 6000,
  toolArgsChars: 2000,
  userTextChars: 20000,
  assistantTextChars: 12000,
  developerTextChars: 2000,
  maxSplitDepth: 4,
});

/** Merge untrusted row config over the defaults (unknown keys ignored). */
export function resolveConfig(config = {}) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = config?.[key];
    if (value === undefined || value === null) continue;
    if (typeof DEFAULTS[key] !== typeof value) continue;
    if (typeof value === 'number' && !(Number.isFinite(value) && value > 0)) continue;
    out[key] = value;
  }
  if (out.archiveDir.startsWith('~/')) out.archiveDir = join(homedir(), out.archiveDir.slice(2));
  if (out.handoffDir.startsWith('~/')) out.handoffDir = join(homedir(), out.handoffDir.slice(2));
  out.chunkWindowRatio = Math.min(out.chunkWindowRatio, 0.95);
  return Object.freeze(out);
}

// ---------------------------------------------------------------- utilities

/** True when an error (or anything in its cause chain) is a context overflow. */
export function isOverflow(error) {
  let current = error;
  for (let depth = 0; current && depth < 10; depth += 1) {
    if (current.code === OVERFLOW_CODE || current.failure?.code === OVERFLOW_CODE) return true;
    if (typeof current.message === 'string' && OVERFLOW_TEXT.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

function errorText(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current.message) parts.push(String(current.message));
    current = current.cause;
  }
  return [...new Set(parts)].join(' <- ').slice(0, 600) || String(error);
}

/** Keep head and tail of an over-long text, marking the cut. */
export function clip(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head);
  return `${text.slice(0, head)}\n[... ${text.length - head - tail} chars omitted here; the full text is in the archive ...]\n${tail > 0 ? text.slice(-tail) : ''}`;
}

/** A Markdown code fence longer than any backtick run inside the text. */
function fenced(text, lang = '') {
  const runs = String(text).match(/`{3,}/g) ?? [];
  const width = Math.max(3, ...runs.map((run) => run.length + 1));
  const fence = '`'.repeat(width);
  return `${fence}${lang}\n${text}\n${fence}`;
}

function prettyArgs(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return String(raw ?? '');
  }
}

function attachmentLabel(block) {
  const a = block.attachment ?? {};
  if (block.type === 'image') return `[image ${a.width ?? '?'}x${a.height ?? '?'} ${a.mediaType ?? ''} ${a.attachmentId ?? ''}]`.replace(/\s+\]/, ']');
  return `[file ${a.name ?? '?'} (${a.bytes ?? '?'} bytes) ${a.attachmentId ?? ''}]`.replace(/\s+\]/, ']');
}

function roleLabel(message, toolNames) {
  switch (message.role) {
    case 'user': return message.source?.kind === 'compact-checkpoint' ? 'Earlier checkpoint' : 'User';
    case 'assistant': return 'Assistant';
    case 'tool': {
      const toolName = toolNames.get(message.toolCallId);
      return `Tool result${toolName ? ` (${toolName})` : ''}${message.isError ? ' [error]' : ''}`;
    }
    case 'developer': return 'Context';
    case 'system': return 'System prompt';
    default: return String(message.role ?? 'message');
  }
}

function toolNameIndex(messages) {
  const names = new Map();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content ?? []) if (block.type === 'tool-call') names.set(block.id, block.name);
  }
  return names;
}

// ---------------------------------------------------------------- rendering

/** Verbatim Markdown archive of a replayed span (nothing truncated). */
export function renderArchive(messages, meta) {
  const toolNames = toolNameIndex(messages);
  const conversation = messages.filter((m) => m.role !== 'system');
  const system = messages.find((m) => m.role === 'system');
  const out = [
    '# Compacted conversation archive',
    '',
    `- Session: \`${meta.sessionId}\``,
    `- Archived: ${meta.when}`,
    `- Messages: ${conversation.length} (the span a compaction checkpoint replaced)`,
    `- How: ${meta.mode}`,
    '',
    'Everything below is verbatim, in order. Headings are "## [n] Role", so a message can be found with grep "^## \\[n\\]".',
    '',
  ];
  conversation.forEach((message, index) => {
    out.push('---', '', `## [${index + 1}] ${roleLabel(message, toolNames)}`, '');
    for (const block of message.content ?? []) {
      switch (block.type) {
        case 'text': out.push(message.role === 'tool' ? fenced(block.text) : block.text, ''); break;
        case 'reasoning': out.push('<details><summary>reasoning</summary>', '', block.text, '', '</details>', ''); break;
        case 'tool-call': out.push(`**Tool call** \`${block.name}\` (id \`${block.id}\`)`, '', fenced(prettyArgs(block.arguments), 'json'), ''); break;
        case 'tool-addition': out.push(`[tool added: ${block.toolName}]`, ''); break;
        case 'tool-removal': out.push(`[tool removed: ${block.toolName}]`, ''); break;
        case 'image': case 'file': out.push(attachmentLabel(block), ''); break;
        default: out.push(`[${block.type} block]`, '');
      }
    }
  });
  if (system !== undefined) {
    out.push('---', '', '## System prompt at compaction time (verbatim)', '');
    for (const block of system.content ?? []) if (block.type === 'text') out.push(fenced(block.text), '');
  }
  return out.join('\n');
}

/** One compact text unit per message, for the summarizer (capped, no reasoning). */
export function renderUnits(messages, cfg) {
  const toolNames = toolNameIndex(messages);
  const units = [];
  messages.filter((m) => m.role !== 'system').forEach((message, index) => {
    const n = index + 1;
    const lines = [];
    const cap = message.role === 'user' ? cfg.userTextChars
      : message.role === 'assistant' ? cfg.assistantTextChars
        : message.role === 'tool' ? cfg.toolResultChars : cfg.developerTextChars;
    for (const block of message.content ?? []) {
      switch (block.type) {
        case 'text': {
          const text = block.text.replace(REMINDER, '[system reminder omitted]');
          if (text.trim().length > 0) lines.push(clip(text, cap));
          break;
        }
        case 'tool-call': lines.push(`-> ${block.name} ${clip(block.arguments ?? '', cfg.toolArgsChars)}`); break;
        case 'image': case 'file': lines.push(attachmentLabel(block)); break;
        case 'tool-addition': lines.push(`[tool added: ${block.toolName}]`); break;
        case 'tool-removal': lines.push(`[tool removed: ${block.toolName}]`); break;
        default: break; // reasoning stays in the archive only
      }
    }
    if (lines.length === 0) return;
    units.push({ n, text: `[#${n} ${roleLabel(message, toolNames)}]\n${lines.join('\n')}` });
  });
  return units;
}

/** Greedily pack ordered units into chunks of at most `budget` chars; an over-long unit is clipped. */
export function pack(units, budget) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const unit of units) {
    const text = unit.text.length > budget ? clip(unit.text, budget) : unit.text;
    const item = { ...unit, text };
    if (current.length > 0 && size + text.length + 2 > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += text.length + 2;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const chunkText = (chunk) => chunk.map((unit) => unit.text).join('\n\n');
const summaryText = (result) => (result.summary ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

function systemMessage(text) {
  return { id: `force-compact-${randomUUID()}`, role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] };
}

function pointerBlock(archive) {
  if (archive === null) return '## Archived Transcript\n- (the verbatim archive could not be written; see the server log)';
  return [
    '## Archived Transcript',
    `- The verbatim transcript of everything this checkpoint replaces (${archive.messages} messages, ${archive.lines} lines, ~${Math.round(archive.chars / 4000)}K tokens) is saved at: \`${archive.path}\``,
    '- When a detail is missing above (exact output, code, numbers, a user instruction), grep that file or read it in slices with offset/limit instead of guessing. Messages are headed "## [n] Role".',
  ].join('\n');
}

/** Mechanical checkpoint used by `--pointer` (no model call). */
export function mechanicalSummary(messages, archive) {
  const conversation = messages.filter((m) => m.role !== 'system');
  const textOf = (m) => (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').replace(REMINDER, '').trim();
  const asks = conversation.filter((m) => m.role === 'user' && m.source?.kind !== 'compact-checkpoint')
    .map(textOf).filter((t) => t.length > 0);
  const prior = conversation.filter((m) => m.role === 'user' && m.source?.kind === 'compact-checkpoint').map(textOf).at(-1);
  const lastAnswer = conversation.filter((m) => m.role === 'assistant').map(textOf).filter((t) => t.length > 0).at(-1);
  const shown = asks.slice(-30);
  const lines = [
    '## Primary Request and Intent',
    '- (mechanical checkpoint made by /force-compact --pointer: no model summary; the user messages below are verbatim, clipped)',
  ];
  if (asks.length > shown.length) lines.push(`- (${asks.length - shown.length} earlier user messages are only in the archive)`);
  for (const ask of shown) lines.push(`- ${clip(ask, 800).replace(/\n+/g, ' / ')}`);
  if (prior) lines.push('', '## Earlier Checkpoint (verbatim, clipped)', clip(prior, 6000));
  lines.push('', '## Current Work', lastAnswer ? `- Last assistant message: ${clip(lastAnswer, 3000)}` : '- (none)');
  lines.push('', '## Next Step', '- Re-read the archive below where needed, then confirm with the user what to continue.');
  lines.push('', pointerBlock(archive));
  return lines.join('\n');
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// ---------------------------------------------------------------- engine side

function summarizationTarget(engine, agent) {
  const cfg = engine.config ?? {};
  const routed = agent.session?.requestHeader?.()?.config;
  const override = routed && Array.isArray(cfg.modelPolicies)
    ? cfg.modelPolicies.find((p) => p.provider === routed.provider && p.model === routed.model) : undefined;
  const provider = override?.summarizationProvider ?? cfg.summarizationProvider;
  const model = override?.summarizationModel ?? cfg.summarizationModel;
  const maxTokens = override?.maxTokens ?? cfg.maxTokens;
  if (provider) return { provider, model, maxTokens };
  if (routed?.provider && routed?.model) return { provider: routed.provider, model: routed.model, maxTokens };
  if (agent.options?.provider && agent.options?.model) return { provider: agent.options.provider, model: agent.options.model, maxTokens };
  return { provider: undefined, model: undefined, maxTokens };
}

async function chunkBudgetChars(engine, agent, signal, cfg) {
  const target = summarizationTarget(engine, agent);
  let window = cfg.fallbackContextWindow;
  if (target.provider && typeof engine.ctx?.llm?.resolveModelInfo === 'function') {
    try {
      const info = await engine.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
      if (Number.isInteger(info?.context?.contextWindow) && info.context.contextWindow > 0) window = info.context.contextWindow;
    } catch { /* keep the fallback window */ }
  }
  const reserve = (target.maxTokens ?? cfg.defaultSummaryMaxTokens) + 4000;
  const tokens = Math.max(cfg.minChunkTokens, Math.min(cfg.maxChunkTokens, Math.floor(window * cfg.chunkWindowRatio) - reserve));
  return { chars: tokens * cfg.charsPerToken, window, tokens, target };
}

async function writeArchive(state, agent, messages, mode) {
  const cfg = state.cfg;
  try {
    const sessionId = String(agent.session?.id ?? 'unknown-session');
    const dir = join(cfg.archiveDir, sessionId.replace(/[^A-Za-z0-9._-]/g, '_'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const when = new Date().toISOString();
    const path = join(dir, `${when.replace(/[:.]/g, '-')}.md`);
    const markdown = renderArchive(messages, { sessionId, when, mode });
    await writeFile(path, markdown, { mode: 0o600 });
    return {
      path,
      chars: markdown.length,
      lines: markdown.split('\n').length,
      messages: messages.filter((m) => m.role !== 'system').length,
    };
  } catch (error) {
    state.log('warn', `archive write failed: ${errorText(error)}`);
    return null;
  }
}

/** The map-reduce summarizer. `original` is compaction-basic's own summarize. */
async function chunkedSummarize(state, engine, original, input, agent, signal, options) {
  const cfg = state.cfg;
  const messages = input.messages ?? [];
  const archive = options.archive ?? await writeArchive(state, agent, messages, options.reason);
  const budget = await chunkBudgetChars(engine, agent, signal, cfg);
  const units = renderUnits(messages, cfg);
  if (units.length === 0) throw new Error('force-compact: the selected span has no text to summarize');
  const where = archive ? `The full verbatim transcript is archived at ${archive.path}; tool outputs below are clipped.` : 'Tool outputs below are clipped.';
  const focus = options.focus ? `\nThe user asked this checkpoint to pay particular attention to: ${options.focus}` : '';
  let calls = 0;

  const call = async (text) => {
    signal?.throwIfAborted?.();
    calls += 1;
    return original.call(engine, { messages: [systemMessage(text)] }, agent, signal);
  };

  const summarizeChunk = async (chunk, label, depth) => {
    const first = chunk[0].n;
    const last = chunk.at(-1).n;
    const header = [
      `You are reading ${label} of a long AI coding-assistant conversation that is too large to read at once: messages #${first} to #${last}, oldest first.`,
      'The other parts are condensed separately and merged afterwards, so record everything from THIS part that a successor needs: requests, decisions, file paths, commands, errors, results and open items. Keep chronological order where it matters.',
      where + focus,
      '',
      '=== CONVERSATION PART START ===',
    ].join('\n');
    try {
      return await call(`${header}\n${chunkText(chunk)}\n=== CONVERSATION PART END ===`);
    } catch (error) {
      if (signal?.aborted || !isOverflow(error) || depth >= cfg.maxSplitDepth) throw error;
      state.log('info', `${label} still overflowed; splitting it`);
      let halves;
      if (chunk.length > 1) {
        const mid = Math.ceil(chunk.length / 2);
        halves = [chunk.slice(0, mid), chunk.slice(mid)];
      } else {
        const unit = chunk[0];
        const half = Math.max(1000, Math.floor(unit.text.length / 2));
        halves = [[{ ...unit, text: clip(unit.text, half) }]];
      }
      const parts = [];
      for (const [i, half] of halves.entries()) parts.push(await summarizeChunk(half, `${label}${'ab'[i]}`, depth + 1));
      return parts.length === 1 ? parts[0] : merge(parts);
    }
  };

  const merge = async (parts) => {
    let level = parts;
    for (let round = 0; ; round += 1) {
      const texts = level.map((result, i) => ({ n: i + 1, text: `<compacted-summary part="${i + 1}">\n${summaryText(result)}\n</compacted-summary>` }));
      const groups = pack(texts, budget.chars);
      const mergeHeader = (count) => [
        `Below are ${count} checkpoints. Each condenses one consecutive part of the SAME conversation, oldest first.`,
        'Merge them into ONE checkpoint: keep every still-relevant fact, request, decision, path and command; later parts win where they conflict; "Current Work" and "Next Step" come from the LAST part.',
        where + focus,
        '',
      ].join('\n');
      if (groups.length === 1 || round >= 6) {
        return call(`${mergeHeader(texts.length)}${chunkText(groups[0])}`);
      }
      level = await mapLimit(groups, cfg.concurrency, (group) => call(`${mergeHeader(group.length)}${chunkText(group)}`));
    }
  };

  const chunks = pack(units, budget.chars);
  state.log('info', `chunked summary (${options.reason}): ${units.length} messages in ${chunks.length} part(s) of <= ~${budget.tokens} tokens (window ${budget.window})`);
  const parts = await mapLimit(chunks, cfg.concurrency, (chunk, i) => summarizeChunk(chunk, `part ${i + 1} of ${chunks.length}`, 0));
  const final = parts.length === 1 ? parts[0] : await merge(parts);
  options.run && Object.assign(options.run, { parts: chunks.length, calls, archive });
  return { ...final, summary: [...(final.summary ?? []), { type: 'text', text: `\n${pointerBlock(archive)}` }] };
}

// ---------------------------------------------------------------- handoff and clear

/** The handoff sections the model fills in; a user template replaces exactly this part. */
export const DEFAULT_HANDOFF_TEMPLATE = [
  '# Handoff',
  '## 1. Role and standing orders',
  '- [who you are in this chat; the user\'s standing instructions, preferences and constraints, quoted verbatim where the wording matters]',
  '## 2. Goal and current state',
  '- [the overall goal, and precisely where the work stands now]',
  '## 3. Decisions made',
  '- [decision: reason; alternatives rejected]',
  '## 4. Open items and pending requests',
  '- [everything requested and not yet done; quote the user\'s most recent requests verbatim]',
  '## 5. Files, paths, services, commands',
  '- [exact paths, ids, URLs, commands and their purpose]',
  '## 6. Running work',
  '- [subagents, background jobs, schedules or other chats still working: ids, what they do, where results will land]',
  '## 7. Gotchas',
  '- [what failed and why, traps to avoid, things verified not to work]',
  '## 8. Next step',
  '- [the single next action, in line with the most recent request]',
].join('\n')

/** The /new instruction. The marker on the first line is stable on purpose (tests and log greps). */
export function handoffInstruction(focus, template, runningWork) {
  const sections = typeof template === 'string' && template.trim() ? template.trim().slice(0, 8000) : DEFAULT_HANDOFF_TEMPLATE
  return [
    'CONDUCTOR-HANDOFF',
    'You are handing this conversation over to a fresh context of yourself. After this message everything above is removed from your context. You keep only the document you write now, plus the system prompt, the workspace instructions and the pinned messages, which are re-added automatically. Write the handoff that lets you continue the work seamlessly, as if nothing had happened.',
    '',
    'Output EXACTLY this Markdown structure: every section, in order. Use terse bullets. Write "(none)" for an empty section, never drop one.',
    '',
    sections,
    '',
    'Rules:',
    '- Write in the main language of the conversation.',
    '- Preserve exact file paths, commands, identifiers, error strings and numbers. Prefer facts over narrative.',
    '- Never copy secret values (keys, tokens, passwords); name where they are stored instead.',
    '- Do not repeat the pinned messages: they are kept verbatim separately.',
    '- If the conversation contains a <compacted-summary> block or an earlier handoff, carry forward what is still true and drop what is stale.',
    '- Do not mention this request. Output only the document. Do not call any tool.',
    ...(runningWork ? ['', 'Work still running right now (list it where the structure asks for running work, with these ids):', runningWork] : []),
    ...(focus ? ['', `The user asked this handoff to pay particular attention to: ${focus}`] : []),
  ].join('\n')
}

function withPins(result, pins) {
  const block = pinsBlock(pins);
  if (!block) return result;
  return { ...result, summary: [...(result.summary ?? []), { type: 'text', text: `\n\n${block}` }] };
}

function pinsBlock(pins) {
  if (!Array.isArray(pins) || pins.length === 0) return '';
  const lines = ['## Pinned messages (kept verbatim across resets)'];
  for (const pin of pins) {
    const who = pin.role === 'user' ? 'User' : pin.role === 'assistant' ? 'Assistant' : 'Message';
    const note = pin.note ? ` (note: ${pin.note})` : '';
    lines.push('', `### ${who}${note}`, '', clip(String(pin.text ?? ''), 6000));
  }
  return lines.join('\n');
}

function handoffPointer(archive, handoff, previous) {
  const lines = ['## Earlier history'];
  if (archive) lines.push(`- Verbatim transcript of everything this handoff replaces (${archive.messages} messages, ~${Math.round(archive.chars / 4000)}K tokens): \`${archive.path}\``);
  else lines.push('- (the verbatim archive could not be written; see the server log)');
  if (handoff) lines.push(`- This handoff as a file: \`${handoff}\``);
  if (previous) lines.push(`- Previous handoff: \`${previous}\``);
  lines.push('- When a detail is missing above, search those files (grep, or read slices with offset/limit) instead of guessing. Never read an archive whole.');
  return lines.join('\n');
}

/** The /clear checkpoint: what remains in context after the history is cleared. */
export function clearPlaceholder(archive, forced = {}) {
  const when = new Date().toISOString();
  const lines = [
    `The conversation history was cleared by the user at ${when}. Earlier messages are no longer in context: do not refer to them as if you remembered them, and ask when something is unclear.`,
  ];
  if (archive) lines.push(`If the user explicitly asks about earlier work, the verbatim transcript is at \`${archive.path}\` (search it, never read it whole).`);
  const pins = pinsBlock(forced.pins);
  if (pins) lines.push('', pins);
  return lines.join('\n');
}

async function streamText(engine, agent, messages, input, signal) {
  const llmModule = (await importCore('@deepseek-ai/dsh-llm')).mod;
  const Assembler = llmModule?.BlockAssembler;
  const llm = engine.ctx?.llm;
  if (typeof Assembler !== 'function' || typeof llm?.stream !== 'function') return null;
  const target = summarizationTarget(engine, agent);
  if (!target.provider) throw new Error('no provider/model available to write the handoff: route one request first or configure the compaction summarization model');
  const assembler = new Assembler();
  const options = {
    provider: target.provider,
    model: target.model,
    messages,
    toolHistory: agent.session.toolHistory(),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    ...(target.maxTokens === undefined ? {} : { maxTokens: target.maxTokens }),
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  };
  for await (const chunk of llm.stream(options)) assembler.push(chunk);
  const finish = assembler.finish;
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    const error = new Error(finish.failure?.message ?? 'the model call failed');
    error.code = finish.failure?.code;
    throw error;
  }
  if (finish?.kind === 'max-tokens') {
    const error = new Error('the handoff was truncated at the token cap');
    error.code = 'MAX_TOKENS';
    throw error;
  }
  const blocks = assembler.blocks().filter((block) => block.type === 'text');
  const text = blocks.map((block) => block.text).join('').trim();
  if (text.length === 0) throw new Error('the model returned an empty handoff');
  return { text, provider: target.provider, model: target.model, usage: assembler.usage };
}

async function writeHandoff(state, agent, text) {
  try {
    const sessionId = String(agent.session?.id ?? 'unknown-session');
    const dir = join(state.cfg.handoffDir, sessionId.replace(/[^A-Za-z0-9._-]/g, '_'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    await writeFile(path, `${text}\n`, { mode: 0o600 });
    return path;
  } catch (error) {
    state.log('warn', `handoff write failed: ${errorText(error)}`);
    return null;
  }
}

/**
 * /new: one model call over the full replayed context (cache-friendly: the
 * same prefix the conversation already sent) with the handoff instruction as
 * the last user message. Falls back to the chunked summarizer plus one small
 * rewrite call when the context no longer fits, and to the regular compaction
 * summary when the LLM seam is unavailable.
 */
async function handoffSummarize(state, engine, original, input, agent, signal, forced) {
  const run = forced.run;
  const messages = input.messages ?? [];
  const archive = await writeArchive(state, agent, messages, 'conductor /new (handoff)');
  run.archive = archive;
  const instruction = { role: 'user', content: [{ type: 'text', text: handoffInstruction(forced.focus, forced.template, forced.runningWork) }] };
  let written = null;
  let calls = 0;
  let overflowed = false;
  try {
    calls += 1;
    written = await streamText(engine, agent, [...messages, instruction], input, signal);
    if (written) run.via = 'one-shot';
  } catch (error) {
    if (signal?.aborted || !isOverflow(error)) throw error;
    overflowed = true;
    state.log('warn', `handoff one-shot overflowed the model window (${errorText(error).slice(0, 160)}); condensing in parts first`);
  }
  if (written === null && !overflowed) {
    // No LLM seam to call directly (older core): the regular compaction
    // summary stands in for the handoff, still archived and pointed to.
    state.log('warn', 'the LLM stream seam is unavailable; /new falls back to the regular compaction summary');
    try {
      const regular = await original.call(engine, input, agent, signal);
      written = { text: `# Handoff\n\n${summaryText(regular)}`, provider: regular.provider, model: regular.model };
      run.via = 'compaction-summary';
    } catch (error) {
      if (signal?.aborted || !isOverflow(error)) throw error;
    }
  }
  if (written === null) {
    const partsRun = {};
    const condensed = await chunkedSummarize(state, engine, original, input, agent, signal, { reason: 'conductor /new (context too large for one call)', focus: forced.focus, run: partsRun, archive });
    calls += partsRun.calls ?? 0;
    const notes = summaryText(condensed).replace(/## Archived Transcript[\s\S]*$/, '').trim();
    const rewrite = [
      { role: 'user', content: [{ type: 'text', text: `Here are condensed notes of a long conversation, oldest first:\n\n<notes>\n${notes}\n</notes>` }] },
      instruction,
    ];
    calls += 1;
    written = await streamText(engine, agent, rewrite, { tools: undefined }, signal).catch((error) => {
      state.log('warn', `handoff rewrite failed (${errorText(error).slice(0, 160)}); using the condensed notes as the handoff`);
      return { text: `# Handoff\n\n${notes}`, provider: undefined, model: undefined };
    }) ?? { text: `# Handoff\n\n${notes}` };
    run.via = 'chunked';
  }
  const handoffPath = await writeHandoff(state, agent, written.text);
  Object.assign(run, { calls, handoff: handoffPath, handoffChars: written.text.length });
  const text = [written.text.trim(), pinsBlock(forced.pins), handoffPointer(archive, handoffPath, forced.previousHandoff)].filter(Boolean).join('\n\n');
  const target = summarizationTarget(engine, agent);
  return {
    summary: [{ type: 'text', text }],
    provider: written.provider ?? target.provider ?? 'dsh-conductor',
    model: written.model ?? target.model ?? 'handoff',
    ...(written.usage ? { usage: written.usage } : {}),
  };
}

/**
 * Wrap `proto.summarize` once. `state` is read at call time, so a plugin
 * reload swaps configuration without stacking wrappers.
 * @returns an uninstaller restoring the original method.
 */
export function installPatch(proto, state) {
  if (proto[PATCH] !== undefined) {
    proto[PATCH].state = state;
    return () => {
      if (proto[PATCH]?.state === state) uninstall(proto);
    };
  }
  const original = proto.summarize;
  const record = { original, state };
  proto[PATCH] = record;
  proto.summarize = async function forceCompactSummarize(input, agent, signal) {
    const live = record.state;
    const sessionId = agent?.session?.id;
    const forced = sessionId === undefined ? undefined : live.forced.get(sessionId);
    if (forced !== undefined) {
      const run = forced.run;
      run.reached = true;
      try {
        if (forced.mode === 'handoff') {
          return await handoffSummarize(live, this, original, input, agent, signal, forced);
        }
        if (forced.mode === 'clear') {
          const archive = await writeArchive(live, agent, input.messages ?? [], 'conductor /clear (no model call)');
          Object.assign(run, { parts: 0, calls: 0, archive });
          const target = summarizationTarget(this, agent);
          return {
            summary: [{ type: 'text', text: clearPlaceholder(archive, forced) }],
            provider: target.provider ?? 'dsh-conductor',
            model: target.model ?? 'clear',
          };
        }
        if (forced.mode === 'pointer') {
          const archive = await writeArchive(live, agent, input.messages ?? [], 'force-compact --pointer (no model call)');
          Object.assign(run, { parts: 0, calls: 0, archive });
          const target = summarizationTarget(this, agent);
          return {
            summary: [{ type: 'text', text: [mechanicalSummary(input.messages ?? [], archive), pinsBlock(forced.pins)].filter(Boolean).join("\n\n") }],
            provider: target.provider ?? 'dsh-force-compact',
            model: target.model ?? 'pointer',
          };
        }
        return withPins(await chunkedSummarize(live, this, original, input, agent, signal, { reason: 'force-compact', focus: forced.focus, run }), forced.pins);
      } catch (error) {
        run.error = errorText(error);
        throw error;
      }
    }
    let result;
    try {
      result = await original.call(this, input, agent, signal);
    } catch (error) {
      if (!live.cfg.overflowFallback || signal?.aborted || !isOverflow(error)) throw error;
      live.log('warn', `one-shot summary overflowed the model window (${errorText(error).slice(0, 160)}); switching to the chunked summary`);
      const run = {};
      const chunked = await chunkedSummarize(live, this, original, input, agent, signal, { reason: 'automatic fallback after a context-window overflow', run });
      live.onCompaction?.({ sessionId, kind: 'compact', archive: run.archive ?? null });
      return withPins(chunked, live.pinsFor?.(sessionId));
    }
    if (!live.cfg.archiveEveryCompaction) {
      live.onCompaction?.({ sessionId, kind: 'compact', archive: null });
      return withPins(result, live.pinsFor?.(sessionId));
    }
    const archive = await writeArchive(live, agent, input.messages ?? [], 'regular compaction (one-shot summary)');
    live.onCompaction?.({ sessionId, kind: 'compact', archive });
    if (archive === null) return result;
    return withPins({ ...result, summary: [...(result.summary ?? []), { type: "text", text: `\n${pointerBlock(archive)}` }] }, live.pinsFor?.(sessionId));
  };
  return () => {
    if (proto[PATCH]?.state === state) uninstall(proto);
  };
}

function uninstall(proto) {
  const record = proto[PATCH];
  if (record === undefined) return;
  proto.summarize = record.original;
  delete proto[PATCH];
}

// ---------------------------------------------------------------- automatic level

const LEVEL_PATCH = Symbol.for('dsh-conductor.level-patch');

/**
 * A copy of the engine config whose automatic trigger sits at `ratio` of the
 * model window (and in every per-model policy, which would otherwise win).
 * The retained tail is lowered when needed so that it stays below the trigger,
 * which core compaction requires.
 */
export function shadowCompactionConfig(config, ratio) {
  const r = Math.min(Math.max(Number(ratio), 0.05), 0.95);
  const retain = (value) => (typeof value === 'number' ? Math.min(value, Math.round(Math.max(0.02, r / 3) * 1000) / 1000) : value);
  const out = { ...config, thresholdRatio: r };
  if (out.retainTokens === undefined) out.retainRatio = retain(out.retainRatio ?? 0.16);
  if (Array.isArray(config.modelPolicies)) {
    out.modelPolicies = config.modelPolicies.map((policy) => {
      const next = { ...policy, thresholdRatio: r };
      if (policy.retainRatio !== undefined) next.retainRatio = retain(policy.retainRatio);
      return Object.freeze(next);
    });
  }
  return Object.freeze(out);
}

/**
 * Wrap `compactIfNeeded` so that a chat with its own automatic level is
 * measured against that level (pressure trigger only; overflow recovery is
 * untouched). `state.levelFor(agent)` answers `{ ratio, action }` or null.
 * When the action is "handoff", the compaction that the level triggers writes
 * a handoff instead of a summary (through the same forced mode /new uses).
 */
export function installLevelPatch(proto, state) {
  if (typeof proto.compactIfNeeded !== 'function') return () => {};
  if (proto[LEVEL_PATCH] !== undefined) {
    proto[LEVEL_PATCH].state = state;
    return () => {
      if (proto[LEVEL_PATCH]?.state === state) uninstallLevel(proto);
    };
  }
  const original = proto.compactIfNeeded;
  const record = { original, state };
  proto[LEVEL_PATCH] = record;
  proto.compactIfNeeded = async function conductorCompactIfNeeded(agent, trigger, signal) {
    const live = record.state;
    let level = null;
    try { level = trigger === 'pressure' ? live.levelFor?.(agent) ?? null : null; } catch { level = null; }
    if (!level || !this.config) return original.call(this, agent, trigger, signal);
    const shadow = Object.create(this, { config: { value: shadowCompactionConfig(this.config, level.ratio) } });
    if (level.action !== 'handoff') {
      return original.call(shadow, agent, trigger, signal);
    }
    const sessionId = agent?.session?.id;
    if (!sessionId || live.forced.has(sessionId)) return original.call(shadow, agent, trigger, signal);
    const forced = { ...(live.handoffOptions?.(agent) ?? {}), mode: 'handoff', run: {}, auto: true };
    live.forced.set(sessionId, forced);
    const before = live.measure?.(agent);
    try {
      const result = await original.call(shadow, agent, trigger, signal);
      if (forced.run.reached) live.onAutoHandoff?.({ agent, run: forced.run, before, result });
      return result;
    } finally {
      live.forced.delete(sessionId);
    }
  };
  return () => {
    if (proto[LEVEL_PATCH]?.state === state) uninstallLevel(proto);
  };
}

function uninstallLevel(proto) {
  const record = proto[LEVEL_PATCH];
  if (record === undefined) return;
  proto.compactIfNeeded = record.original;
  delete proto[LEVEL_PATCH];
}

export async function findEngineProto(ctx) {
  const reasons = [];
  try {
    const found = await importCore('@deepseek-ai/dsh-compaction-basic');
    const Engine = found.mod?.BasicCompactionEngine ?? found.mod?.default;
    if (typeof Engine?.prototype?.summarize === 'function') return { proto: Engine.prototype, via: found.via };
    reasons.push(found.mod ? 'import: no BasicCompactionEngine.summarize' : `import: ${(found.reasons ?? []).join('; ')}`);
  } catch (error) {
    reasons.push(`import: ${errorText(error)}`);
  }
  // Fallback: the running DSH install, derived from the dsh binary's real path.
  try {
    const real = realpathSync(process.argv[1]);
    const at = real.indexOf(`${sep}lib${sep}bin.js`);
    const root = at > 0 ? real.slice(0, at) : undefined;
    const file = root && join(root, 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js');
    if (file && existsSync(file)) {
      const mod = await import(pathToFileURL(file).href);
      const Engine = mod.BasicCompactionEngine ?? mod.default;
      if (typeof Engine?.prototype?.summarize === 'function') return { proto: Engine.prototype, via: `path ${file}` };
    }
    reasons.push('path: dsh install not found');
  } catch (error) {
    reasons.push(`path: ${errorText(error)}`);
  }
  try {
    let proto = ctx.get?.('compaction');
    while (proto && !Object.hasOwn(proto, 'summarize')) proto = Object.getPrototypeOf(proto);
    if (proto) return { proto, via: 'host compaction service' };
    reasons.push('host: no compaction service');
  } catch (error) {
    reasons.push(`host: ${errorText(error)}`);
  }
  return { proto: null, reasons };
}

