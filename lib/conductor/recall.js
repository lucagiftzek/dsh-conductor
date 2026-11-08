/**
 * Archive search ("recall"): find passages in a chat's earlier epochs, the
 * verbatim archives of every /new, /clear and compaction, the saved originals
 * of dropped items and the handoff documents, without reading them whole.
 *
 * Keyword ranking over line windows; no model, no index, no network. Files
 * are cached by mtime, so repeated searches in one chat are cheap.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const cache = new Map() // path -> { mtimeMs, lines }
const MAX_FILE_BYTES = 40 * 1024 * 1024

function linesOf(path) {
  let st
  try { st = statSync(path) } catch { return null }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.lines
  let text
  try { text = readFileSync(path, 'utf8') } catch { return null }
  const lines = text.split('\n')
  cache.set(path, { mtimeMs: st.mtimeMs, lines })
  if (cache.size > 200) cache.delete(cache.keys().next().value)
  return lines
}

function mdFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => join(dir, name))
  } catch {
    return []
  }
}

const safe = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_')

/** Every searchable file of one chat, newest first. */
export function recallSources(sessionId, { archiveDir, handoffDir }) {
  const files = [
    ...mdFiles(join(archiveDir, safe(sessionId))).map((path) => ({ path, kind: 'archive' })),
    ...mdFiles(join(archiveDir, safe(sessionId), 'drops')).map((path) => ({ path, kind: 'dropped' })),
    ...mdFiles(join(handoffDir, safe(sessionId))).map((path) => ({ path, kind: 'handoff' })),
  ]
  return files.sort((a, b) => basename(b.path).localeCompare(basename(a.path)))
}

export function tokenize(query) {
  const phrases = [...String(query).matchAll(/"([^"]{2,200})"/g)].map((m) => m[1].toLowerCase())
  const rest = String(query).replace(/"[^"]*"/g, ' ')
  const terms = [...new Set(rest.toLowerCase().split(/[^\p{L}\p{N}_./:-]+/u).filter((t) => t.length >= 2))].slice(0, 12)
  return { terms, phrases }
}

/**
 * @returns {{ hits: Array<{ path, kind, line, endLine, score, snippet, when }>, searched: number }}
 */
export function recall(sessionId, query, options) {
  const { terms, phrases } = tokenize(query)
  if (terms.length === 0 && phrases.length === 0) return { hits: [], searched: 0, error: 'the query has no searchable words' }
  const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 20)
  const window = 6
  const sources = recallSources(sessionId, options)
  const hits = []
  for (const source of sources) {
    const lines = linesOf(source.path)
    if (!lines) continue
    const lower = lines.map((l) => l.toLowerCase())
    // score every line, then pick the best window around each matching line
    const lineScore = lower.map((l) => {
      let s = 0
      for (const t of terms) if (l.includes(t)) s += 1
      for (const p of phrases) if (l.includes(p)) s += 3
      return s
    })
    const taken = new Set()
    for (let i = 0; i < lines.length; i += 1) {
      if (lineScore[i] === 0 || taken.has(i)) continue
      const from = Math.max(0, i - 2)
      const to = Math.min(lines.length - 1, i + window)
      const text = lower.slice(from, to + 1).join('\n')
      let score = 0
      let covered = 0
      for (const t of terms) {
        const n = text.split(t).length - 1
        if (n > 0) covered += 1
        score += Math.min(n, 4)
      }
      for (const p of phrases) if (text.includes(p)) { score += 6; covered += 1 }
      const all = terms.length + phrases.length
      if (covered === all && all > 1) score += 4
      for (let k = from; k <= to; k += 1) taken.add(k)
      const snippet = lines.slice(from, to + 1).join('\n').slice(0, 700)
      const stamp = basename(source.path).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/)
      hits.push({ path: source.path, kind: source.kind, line: from + 1, endLine: to + 1, score, snippet, when: stamp ? `${stamp[1]} ${stamp[2]}:${stamp[3]} UTC` : undefined })
    }
  }
  hits.sort((a, b) => b.score - a.score || b.path.localeCompare(a.path))
  return { hits: hits.slice(0, limit), searched: sources.length }
}

export function renderRecall(result, query) {
  if (result.error) return `Nothing searched: ${result.error}.`
  if (result.searched === 0) return 'This chat has no earlier epochs yet (no /new, /clear, compaction or drops), so there is nothing to search.'
  if (result.hits.length === 0) return `No match for "${query}" in ${result.searched === 1 ? "1 archived file" : `${result.searched} archived files`}.`
  return result.hits.map((h, i) => [
    `${i + 1}. ${h.kind}${h.when ? `, ${h.when}` : ''}: ${h.path}:${h.line}-${h.endLine}`,
    h.snippet.split('\n').map((l) => `   ${l}`).join('\n'),
  ].join('\n')).join('\n\n')
}

/** Test seam. */
export function clearRecallCache() {
  cache.clear()
}
