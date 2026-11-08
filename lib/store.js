/**
 * dsh-conductor: durable task + event store.
 *
 * One JSON document for tasks (atomic tmp+rename write, 0600), one JSONL
 * append-only activity log with a hard line cap. Both live under the
 * plugin-owned state dir. Nothing here is a database; the shapes are small,
 * the reads are whole-file, and a torn write can only ever lose the newest
 * unsaved state: the load path treats unparseable files as empty.
 */

'use strict'

import fsP from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LIMITS } from './core.js'

export class TaskStore {
  constructor(dir) {
    this.dir = dir
    this.tasksFile = join(dir, 'tasks.json')
    this.eventsFile = join(dir, 'events.jsonl')
    this.tasks = []          // newest-last in memory; persisted as-is
    this.events = []         // bounded ring in memory
    this.dirty = false
  }

  async init() {
    await fsP.mkdir(this.dir, { recursive: true, mode: 0o700 })
    try {
      const raw = await fsP.readFile(this.tasksFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) this.tasks = parsed.filter((t) => t && typeof t === 'object' && typeof t.id === 'string')
    } catch { /* absent or torn: start empty */ }
    try {
      const raw = await fsP.readFile(this.eventsFile, 'utf8')
      const lines = raw.split('\n').filter((l) => l.trim())
      this.events = lines.slice(-LIMITS.eventsKeep).map((l) => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean)
    } catch { /* absent */ }
  }

  /** Async flush (debounced by the engine); awaited on critical transitions. */
  async flush() {
    this.dirty = false
    const tmp = this.tasksFile + '.tmp'
    await fsP.mkdir(dirname(this.tasksFile), { recursive: true })
    await fsP.writeFile(tmp, JSON.stringify(this.tasks), { mode: 0o600 })
    try { await fsP.chmod(tmp, 0o600) } catch { /* best effort */ }
    await fsP.rename(tmp, this.tasksFile)
  }

  async appendEvent(event) {
    const row = { at: new Date().toISOString(), ...event }
    this.events.push(row)
    if (this.events.length > LIMITS.eventsKeep) this.events = this.events.slice(-LIMITS.eventsKeep)
    try {
      await fsP.appendFile(this.eventsFile, JSON.stringify(row) + '\n')
    } catch { /* the log is advisory; never break a task for it */ }
    return row
  }

  tailEvents(n = LIMITS.eventTail) {
    return this.events.slice(-Math.max(1, Math.min(500, n)))
  }

  upsert(task) {
    const i = this.tasks.findIndex((t) => t.id === task.id)
    if (i === -1) this.tasks.push(task)
    else this.tasks[i] = task
    this.dirty = true
    if (this.tasks.length > LIMITS.tasksMax) this.tasks = this.tasks.slice(-LIMITS.tasksMax)
  }

  get(id) {
    return this.tasks.find((t) => t.id === id) || null
  }

  list() {
    return [...this.tasks]
  }

  /** Prune finished tasks beyond historyKeep / historyPruneSeconds. */
  prune(keep, pruneSeconds) {
    const cutoff = Date.now() - Math.max(60, pruneSeconds) * 1000
    const before = this.tasks.length
    const finished = this.tasks.filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
    const doomed = new Set(
      finished
        .filter((t) => (t.finishedAt || 0) < cutoff)
        .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0))
        .slice(0, Math.max(0, finished.length - keep))
        .map((t) => t.id),
    )
    if (doomed.size) {
      this.tasks = this.tasks.filter((t) => !doomed.has(t.id))
      this.dirty = true
    }
    return before - this.tasks.length
  }
}

export const __store = { LIMITS }
