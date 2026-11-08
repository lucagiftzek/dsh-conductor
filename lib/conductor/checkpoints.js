/**
 * Checkpoints and rewind, for the conversation and for files.
 *
 * Checkpoints
 *   - automatic: one at the start of every turn of a top-level chat (the state
 *     just before that prompt), labelled with the prompt;
 *   - manual: /checkpoint [name] marks "now".
 *
 * Files
 *   Before the agent's file tools (write, edit, str_replace and anything that
 *   writes through DSH's file service) change a file for the first time in a
 *   turn, its previous content is copied into Conductor's own store
 *   (<stateDir>/checkpoints/<chat>/objects, content addressed, 0600). At the end
 *   of the turn the new content's hash is noted, so a later restore can tell
 *   when someone else changed the file since. The user's git repository is
 *   never touched. Changes made by shell commands, scripts or other programs
 *   are NOT tracked (like Claude Code): restore lists that limit plainly.
 *
 * Rewind (only while the chat is idle)
 *   - chat: everything in the model context after the checkpoint is replaced by
 *     one short notice (archived verbatim first). The chat window keeps showing
 *     the old messages above a "Rewound" marker. Not undoable (the archive
 *     keeps the text); when a compaction already merged the checkpoint into a
 *     summary, an exact rewind is impossible and --branch is offered instead.
 *   - files: every tracked file goes back to its content at the checkpoint;
 *     files created after it are removed. Files changed outside the agent since
 *     its last edit are skipped as conflicts unless forced. The files' current
 *     content is saved first, so "rewind undo" brings it back.
 *   - branch: a new chat forked at the checkpoint (exact history, pins copied),
 *     the original chat untouched.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, renameSync, unlinkSync, readdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { eventIndex, compactionOpen, messageOf, noticeMessage } from '../context/surface.js'
import { renderArchive } from '../context/engine.js'
import { importCore } from '../context/core-imports.js'

export const REWIND_SOURCE_KIND = 'dsh-conductor-rewind'
export const LIMITS = Object.freeze({ checkpoints: 100, fileBytes: 2 * 1024 * 1024, filesPerTurn: 300 })

const safe = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '')

function readRegular(path) {
  let st
  try { st = lstatSync(path) } catch { return { exists: false } }
  if (st.isSymbolicLink()) return { exists: true, skip: 'symbolic link' }
  if (!st.isFile()) return { exists: true, skip: 'not a regular file' }
  if (st.nlink > 1) return { exists: true, skip: 'hard link' }
  if (st.size > LIMITS.fileBytes) return { exists: true, skip: `larger than ${LIMITS.fileBytes / 1024 / 1024} MB` }
  return { exists: true, content: readFileSync(path), mode: st.mode & 0o777 }
}

function atomicWrite(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.conductor-${process.pid}-${Date.now()}.tmp`
  writeFileSync(tmp, content, { mode: mode ?? 0o644 })
  if (mode !== undefined) chmodSync(tmp, mode)
  renameSync(tmp, path)
}

export function createCheckpoints(ctx, conductor, { stateDir, log = () => {}, warn = () => {} } = {}) {
  const store = conductor.store
  const root = join(stateDir, 'checkpoints')
  const execSession = new WeakMap() // tool execution -> session
  const openTurns = new Map() // sessionId -> { startSeq, files: Map(path -> entry) }

  const dirFor = (sessionId) => join(root, safe(sessionId))
  const objectPath = (sessionId, sha) => join(dirFor(sessionId), 'objects', sha.slice(0, 2), sha)
  const manifestDir = (sessionId) => join(dirFor(sessionId), 'manifests')

  function putObject(sessionId, content) {
    const sha = sha256(content)
    const path = objectPath(sessionId, sha)
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, content, { mode: 0o600 })
    }
    return sha
  }

  function topLevel(session) {
    const depth = session?.header?.delegationDepth
    return !depth
  }

  // ── recording ──────────────────────────────────────────────────────────
  function onSessionEvent(session, event) {
    if (!session?.id || !topLevel(session)) return
    if (event.type === 'turn/start') {
      openTurns.set(session.id, { startSeq: Number(event.seq), turn: event.data?.turn, files: new Map(), labelled: false })
      store.update(session.id, (s) => {
        s.checkpoints = Array.isArray(s.checkpoints) ? s.checkpoints : []
        s.checkpoints.push({ id: `cp-${randomUUID().slice(0, 8)}`, kind: 'turn', at: new Date(event.time ?? Date.now()).toISOString(), boundarySeq: Number(event.seq), turn: event.data?.turn, label: '' })
        if (s.checkpoints.length > LIMITS.checkpoints) s.checkpoints = s.checkpoints.slice(-LIMITS.checkpoints)
      })
      return
    }
    if (event.type === 'user/message') {
      const open = openTurns.get(session.id)
      if (!open || open.labelled) return
      const message = messageOf(event)
      if (!message) return
      open.labelled = true
      const auto = message.source?.kind !== 'user' && message.source?.kind !== 'user-rpc'
      const label = textOf(message.content).replace(/\s+/g, ' ').trim().slice(0, 120)
      store.update(session.id, (s) => {
        const cp = (s.checkpoints ?? []).findLast?.((c) => c.boundarySeq === open.startSeq) ?? [...(s.checkpoints ?? [])].reverse().find((c) => c.boundarySeq === open.startSeq)
        if (cp) { cp.label = label || '(no text)'; if (auto) cp.auto = true; cp.messageId = message.id }
      })
      return
    }
    if (event.type === 'turn/end') {
      const open = openTurns.get(session.id)
      openTurns.delete(session.id)
      if (!open || open.files.size === 0) return
      const files = []
      for (const entry of open.files.values()) {
        const now = readRegular(entry.path)
        files.push({ ...entry, postSha: now.content ? sha256(now.content) : null, postExists: now.exists && !now.skip ? Boolean(now.content) : now.exists })
      }
      try {
        mkdirSync(manifestDir(session.id), { recursive: true, mode: 0o700 })
        writeFileSync(join(manifestDir(session.id), `${String(open.startSeq).padStart(10, '0')}.json`), JSON.stringify({ startSeq: open.startSeq, turn: open.turn, files }, null, 1), { mode: 0o600 })
        store.update(session.id, (s) => {
          const cp = (s.checkpoints ?? []).find((c) => c.boundarySeq === open.startSeq)
          if (cp) cp.files = files.length
        })
        prune(session.id)
      } catch (error) {
        warn(`checkpoints: manifest not written (${error?.message || error})`)
      }
    }
  }

  function capture(target, actor) {
    const session = actor ? execSession.get(actor) : undefined
    if (!session) return
    const open = openTurns.get(session.id)
    if (!open) return
    let path
    try { path = ctx.get('fs')?.processPath?.(target) ?? target?.path } catch { path = target?.path }
    if (typeof path !== 'string' || open.files.has(path)) return
    if (open.files.size >= LIMITS.filesPerTurn) return
    const before = readRegular(path)
    const entry = { path, existed: before.exists }
    if (before.skip) entry.skipped = before.skip
    else if (before.content) {
      try { entry.preSha = putObject(session.id, before.content); entry.mode = before.mode } catch (error) { entry.skipped = `could not save (${error?.code || error?.message})` }
    }
    open.files.set(path, entry)
  }

  function install() {
    const offs = []
    if (typeof ctx.on !== 'function') return () => {}
    offs.push(ctx.on('session/event', (session, event) => {
      try { onSessionEvent(session, event) } catch (error) { warn(`checkpoints: ${error?.message || error}`) }
    }))
    offs.push(ctx.on('tools/pre-execute', async (exec, next) => {
      const session = exec?.agent?.session
      if (session) execSession.set(exec, session)
      return next()
    }))
    const wrap = async (target, actor, next) => {
      const intent = await next()
      try { capture(target, actor) } catch (error) { warn(`checkpoints: capture failed (${error?.message || error})`) }
      return intent
    }
    offs.push(ctx.on('fs/write-intent', wrap, { prepend: true }))
    offs.push(ctx.on('fs/edit-intent', wrap, { prepend: true }))
    log('checkpoints: a checkpoint per turn; file pre-images of the agent\'s file tools are kept')
    return () => { for (const off of offs) try { off?.() } catch { /* gone */ } }
  }

  // ── manifests and retention ────────────────────────────────────────────
  function manifests(sessionId) {
    let names = []
    try { names = readdirSync(manifestDir(sessionId)).filter((n) => n.endsWith('.json')).sort() } catch { return [] }
    const out = []
    for (const name of names) {
      try { out.push({ name, ...JSON.parse(readFileSync(join(manifestDir(sessionId), name), 'utf8')) }) } catch { /* skip a broken manifest */ }
    }
    return out
  }

  function prune(sessionId) {
    const state = store.get(sessionId)
    const oldest = (state.checkpoints ?? [])[0]?.boundarySeq
    if (oldest === undefined) return
    const all = manifests(sessionId)
    const drop = all.filter((m) => m.startSeq < oldest && m.kind !== 'restore')
    if (!drop.length) return
    for (const m of drop) try { unlinkSync(join(manifestDir(sessionId), m.name)) } catch { /* already gone */ }
    const keep = new Set(manifests(sessionId).flatMap((m) => m.files.map((f) => f.preSha)).filter(Boolean))
    const objects = join(dirFor(sessionId), 'objects')
    try {
      for (const sub of readdirSync(objects)) for (const sha of readdirSync(join(objects, sub))) if (!keep.has(sha)) unlinkSync(join(objects, sub, sha))
    } catch { /* nothing to sweep */ }
  }

  // ── listing ────────────────────────────────────────────────────────────
  function list(sessionId) {
    const cps = [...(store.get(sessionId).checkpoints ?? [])].reverse()
    return cps
  }

  function resolveCheckpoint(sessionId, target) {
    const cps = list(sessionId)
    if (!cps.length) return null
    if (target === undefined || target === '' || target === 'last') return cps.find((c) => !c.auto) ?? cps[0]
    const n = Number(target)
    if (Number.isInteger(n) && n >= 1 && String(n) === String(target).trim()) return cps[n - 1] ?? null
    return cps.find((c) => c.id === target || (c.name && c.name.toLowerCase() === String(target).toLowerCase())) ?? null
  }

  function mark(sessionId, name, { by = 'user' } = {}) {
    const agent = ctx.agents?.get?.(sessionId)
    const boundarySeq = agent ? agent.session.snapshotEvents().length : null
    if (boundarySeq === null) throw new conductor.ConductorError('not-found', 'that chat is not loaded')
    const cp = { id: `cp-${randomUUID().slice(0, 8)}`, kind: 'manual', at: new Date().toISOString(), boundarySeq, name: name ? String(name).slice(0, 80) : undefined, label: name ? String(name).slice(0, 120) : 'Manual checkpoint', by }
    store.update(sessionId, (s) => {
      s.checkpoints = Array.isArray(s.checkpoints) ? s.checkpoints : []
      s.checkpoints.push(cp)
      if (s.checkpoints.length > LIMITS.checkpoints) s.checkpoints = s.checkpoints.slice(-LIMITS.checkpoints)
      s.activity.push({ at: cp.at, kind: 'checkpoint', text: `Checkpoint${cp.name ? ` "${cp.name}"` : ''} set`, by })
    })
    return { ok: true, checkpoint: cp, text: `Checkpoint${cp.name ? ` "${cp.name}"` : ''} set. /rewind ${cp.name ? `"${cp.name}"` : cp.id} brings the chat and the agent's file edits back here.` }
  }

  // ── files ──────────────────────────────────────────────────────────────
  /** What restoring to boundarySeq would do: [{ path, action: restore|delete|keep, conflict?, skipped? }] */
  function filePlan(sessionId, boundarySeq) {
    const after = manifests(sessionId).filter((m) => m.startSeq >= boundarySeq && m.kind !== 'restore')
    const first = new Map()
    const last = new Map()
    for (const m of after) {
      for (const f of m.files) {
        if (!first.has(f.path)) first.set(f.path, f)
        last.set(f.path, f)
      }
    }
    const plan = []
    for (const [path, f] of first) {
      if (f.skipped) { plan.push({ path, action: 'keep', skipped: f.skipped }); continue }
      const now = readRegular(path)
      const lastPost = last.get(path)
      const nowSha = now.content ? sha256(now.content) : null
      const conflict = lastPost && lastPost.postSha !== undefined && nowSha !== (lastPost.postSha ?? null) && !(lastPost.postSha === null && !now.exists)
      if (now.skip) { plan.push({ path, action: 'keep', skipped: now.skip }); continue }
      plan.push({ path, action: f.existed ? 'restore' : 'delete', preSha: f.preSha, mode: f.mode, conflict: Boolean(conflict), unchanged: f.existed ? nowSha === f.preSha : !now.exists })
    }
    return plan.filter((p) => !p.unchanged)
  }

  function restoreFiles(sessionId, plan, { force = false } = {}) {
    const done = []
    const conflicts = []
    const failed = []
    const backup = []
    for (const p of plan) {
      if (p.action === 'keep') continue
      if (p.conflict && !force) { conflicts.push(p.path); continue }
      try {
        const now = readRegular(p.path)
        backup.push({ path: p.path, existed: now.exists, ...(now.content ? { preSha: putObject(sessionId, now.content), mode: now.mode } : {}), postSha: null })
        if (p.action === 'delete') { if (now.exists) unlinkSync(p.path) }
        else atomicWrite(p.path, readFileSync(objectPath(sessionId, p.preSha)), p.mode)
        done.push(p.path)
      } catch (error) {
        failed.push({ path: p.path, reason: error?.code || error?.message })
      }
    }
    let undoId = null
    if (backup.length) {
      undoId = `restore-${Date.now()}`
      mkdirSync(manifestDir(sessionId), { recursive: true, mode: 0o700 })
      writeFileSync(join(manifestDir(sessionId), `${undoId}.json`), JSON.stringify({ kind: 'restore', startSeq: -1, id: undoId, at: new Date().toISOString(), files: backup }, null, 1), { mode: 0o600 })
    }
    return { done, conflicts, failed, undoId }
  }

  function undoRestore(sessionId, { by = 'user' } = {}) {
    const restores = manifests(sessionId).filter((m) => m.kind === 'restore').sort((a, b) => String(b.id).localeCompare(String(a.id)))
    const last = restores[0]
    if (!last) return { ok: false, text: 'There is no file restore to undo.' }
    let n = 0
    const failed = []
    for (const f of last.files) {
      try {
        if (f.existed && f.preSha) atomicWrite(f.path, readFileSync(objectPath(sessionId, f.preSha)), f.mode)
        else if (!f.existed && existsSync(f.path)) unlinkSync(f.path)
        n += 1
      } catch (error) {
        failed.push(`${f.path} (${error?.code || error?.message})`)
      }
    }
    try { unlinkSync(join(manifestDir(sessionId), last.name)) } catch { /* gone */ }
    store.update(sessionId, (s) => { s.activity.push({ at: new Date().toISOString(), kind: 'rewind', text: `Undid the last file restore (${n} file${n === 1 ? '' : 's'})`, by }) })
    return { ok: failed.length === 0, text: `Put back ${n} file${n === 1 ? '' : 's'} as they were before the restore.${failed.length ? ` Failed: ${failed.join(', ')}.` : ''}` }
  }

  // ── conversation ───────────────────────────────────────────────────────
  async function rewindChat(agent, cp) {
    const session = agent.session
    const events = eventIndex(session)
    if (compactionOpen(events)) throw new conductor.ConductorError('busy', 'a compaction is running in this chat; try again in a moment')
    const nodes = session.surface.nodes.map(Number)
    const idx = nodes.findIndex((seq) => seq >= cp.boundarySeq)
    if (idx === -1) return { ok: true, nothing: true, text: 'Nothing in the model context comes after that checkpoint.' }
    if (idx === 0) throw new conductor.ConductorError('invalid', 'that checkpoint is before the system prompt')
    const first = events.get(nodes[idx])
    if ((first?.sourceEventSeqs ?? []).some((s) => Number(s) < cp.boundarySeq)) {
      throw new conductor.ConductorError('gone', 'a reset or compaction since then merged that point into a summary, so the conversation cannot be rewound exactly in place; use --branch to continue from it in a new chat')
    }
    const mod = (await importCore('@deepseek-ai/dsh-compaction')).mod
    const startSeq = nodes[idx]
    const endSeq = nodes.at(-1)
    if (mod?.toolPairingBalancedBefore && !(mod.toolPairingBalancedBefore(session, startSeq) && mod.toolPairingBalancedAfter(session, endSeq))) {
      throw new conductor.ConductorError('busy', 'the conversation after that checkpoint is not at a clean step boundary')
    }
    const shadowed = nodes.slice(idx)
    let archivePath = null
    try {
      const dir = join(conductor.engineState.cfg.archiveDir, safe(session.id))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      archivePath = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-rewind.md`)
      const messages = shadowed.map((seq) => { try { return session.deriveEventMessage(events.get(seq)) } catch { return messageOf(events.get(seq)) } }).filter(Boolean)
      writeFileSync(archivePath, renderArchive(messages, { sessionId: session.id, when: new Date().toISOString(), mode: `rewound to checkpoint "${cp.name ?? cp.label}"` }), { mode: 0o600 })
    } catch (error) {
      warn(`rewind: archive not written (${error?.message || error})`)
      archivePath = null
    }
    const label = (cp.name ?? cp.label ?? '').slice(0, 80)
    const text = `[The user rewound this chat to the checkpoint before "${label}" at ${new Date().toISOString()}. Everything after that point was removed from your context${archivePath ? ` (archived at \`${archivePath}\`)` : ''}. Continue from the checkpoint; do not act on the removed part unless the user brings it back.]`
    session.append('user/message', noticeMessage(text, `Rewound to: ${label}`, REWIND_SOURCE_KIND), {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: shadowed,
    })
    await ctx.get('sessions')?.flush?.(session)
    return { ok: true, removedNodes: shadowed.length, archive: archivePath }
  }

  async function branch(sessionId, cp) {
    const controller = ctx.get('sessionController')
    if (!controller?.fork) throw new conductor.ConductorError('invalid', 'forking is not available in this DSH')
    const atSeq = Math.max(0, cp.boundarySeq - 1)
    const forked = await controller.fork({ sessionId, atSeq })
    const state = store.get(sessionId)
    store.update(forked.sessionId, (s) => {
      s.pins = state.pins.map((p) => ({ ...p }))
      s.activity.push({ at: new Date().toISOString(), kind: 'rewind', text: `Branched from ${sessionId} at the checkpoint before "${(cp.name ?? cp.label ?? '').slice(0, 60)}"`, by: 'user' })
    })
    return forked.sessionId
  }

  /**
   * @param options { chat: boolean, files: boolean, branch: boolean, force: boolean, by }
   */
  async function rewind(sessionId, target, options = {}) {
    const { by = 'user' } = options
    const agent = await conductor.agentFor(sessionId)
    if (agent.status === 'running') throw new conductor.ConductorError('busy', 'the agent is working; rewind when it has finished (or stop it)')
    const cp = resolveCheckpoint(sessionId, target)
    if (!cp) throw new conductor.ConductorError('not-found', 'no such checkpoint (see /rewind for the list)')
    const label = (cp.name ?? cp.label ?? '').slice(0, 60)
    const wantChat = options.chat !== false
    const wantFiles = options.files !== false
    const parts = []
    let newChat = null
    let prompt = null
    if (options.branch) {
      newChat = await branch(sessionId, cp)
      parts.push(`New chat ${newChat} continues from the checkpoint before "${label}"; this chat is unchanged.`)
    } else if (wantChat) {
      const r = await rewindChat(agent, cp)
      if (!r.nothing && cp.kind === 'turn' && !cp.auto) prompt = cp.label
      parts.push(r.nothing ? r.text : `The conversation is back at the checkpoint before "${label}" (${r.removedNodes} context items removed${r.archive ? ', archived' : ''}).`)
    }
    let files = { done: [], conflicts: [], failed: [], undoId: null }
    let plan = []
    if (wantFiles) {
      plan = filePlan(sessionId, cp.boundarySeq)
      files = restoreFiles(sessionId, plan, { force: options.force })
      if (plan.length === 0) parts.push('No tracked file changed since then.')
      else {
        if (files.done.length) parts.push(`Restored ${files.done.length} file${files.done.length === 1 ? '' : 's'}${files.undoId ? ' (/rewind undo puts them back)' : ''}.`)
        if (files.conflicts.length) parts.push(`Skipped ${files.conflicts.length} changed outside the agent since its last edit: ${files.conflicts.slice(0, 5).join(', ')}${files.conflicts.length > 5 ? ', ...' : ''} (add --force to overwrite).`)
        if (files.failed.length) parts.push(`Could not restore: ${files.failed.map((f) => `${f.path} (${f.reason})`).join(', ')}.`)
      }
      parts.push('Changes made by shell commands are not tracked.')
    }
    store.update(sessionId, (s) => {
      s.activity.push({ at: new Date().toISOString(), kind: 'rewind', text: `Rewound to the checkpoint before "${label}"${options.branch ? ' (new branch)' : ''}: ${[wantChat && !options.branch ? 'chat' : null, wantFiles ? `${files.done.length} file${files.done.length === 1 ? '' : 's'}` : null].filter(Boolean).join(', ')}`, by })
      s.epochs.push({ id: `ep-${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), kind: 'rewind', by, tokensBefore: null, tokensAfter: null, archive: null, handoff: null, checkpoint: cp.id, files: files.done.length, branch: newChat })
    })
    return { ok: true, checkpoint: cp, newChat, prompt, files, plan, text: parts.join(' ') }
  }

  function preview(sessionId, target) {
    const cp = resolveCheckpoint(sessionId, target)
    if (!cp) return null
    return { checkpoint: cp, files: filePlan(sessionId, cp.boundarySeq) }
  }

  return { install, list, resolveCheckpoint, mark, rewind, preview, undoRestore, filePlan, onSessionEvent, capture, manifests, _execSession: execSession, _openTurns: openTurns }
}
