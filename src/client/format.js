/**
 * Pure helpers of the Conductor browser half: number and time formatting,
 * the context categories, the drop selection math and the word diff.
 * No DOM, no React: node tests import this file directly.
 */

/** Same rounding as the host (lib/conductor/service.js fmtTokens). */
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '?'
  if (n < 1000) return String(Math.round(n))
  if (n < 100000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  if (n < 1000000) return Math.round(n / 1000) + 'K'
  return (n / 1000000).toFixed(2).replace(/0$/, '') + 'M'
}

/** Spoken form for aria labels: 86400 -> "86 thousand". */
export function spokenTokens(n) {
  if (!Number.isFinite(n)) return 'an unknown number of'
  if (n < 1000) return String(Math.round(n))
  if (n < 1000000) return Math.round(n / 1000) + ' thousand'
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + ' million'
}

export function plural(n, one, many) {
  return n === 1 ? one : (many || one + 's')
}

export function toMs(value) {
  if (value === null || value === undefined || value === '') return NaN
  if (typeof value === 'number') return value
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : NaN
}

/** "now", "42s ago", "12 min ago", "3 h ago", "2 d ago". */
export function fmtAgo(value, now = Date.now()) {
  const t = toMs(value)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 10) return 'now'
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.round(s / 60) + ' min ago'
  if (s < 172800) return Math.round(s / 3600) + ' h ago'
  return Math.round(s / 86400) + ' d ago'
}

/** Elapsed timer: 42000 -> "0:42", 3723000 -> "1:02:03". */
export function fmtClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "04:12" today, "yesterday 04:12", "Nov 7 04:12" otherwise. */
export function fmtWhen(value, now = Date.now()) {
  const t = toMs(value)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const n = new Date(now)
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, n)) return 'today ' + hm
  const y = new Date(now - 86400000)
  if (sameDay(d, y)) return 'yesterday ' + hm
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + hm
}

/** Short HH:MM for log lines. */
export function fmtHM(value) {
  const t = toMs(value)
  if (!Number.isFinite(t)) return '--:--'
  const d = new Date(t)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

export function firstLine(text, max = 140) {
  const s = String(text || '').trim().split(/\r?\n/).find((l) => l.trim()) || ''
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '\u2026' : s
}

export function excerpt(text, max = 140) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '\u2026' : s
}

export function shortId(id) {
  const s = String(id || '')
  return s.length > 22 ? s.slice(0, 14) + '\u2026' + s.slice(-4) : s
}

// ── context categories ─────────────────────────────────────────────────

/**
 * Meter groups, in bar order. Host categories (lib/context/surface.js
 * categoryOf, plus the "tools" residual for tool definitions) fold into
 * these. Colours are CSS custom properties defined on the .cdx root.
 */
export const GROUPS = [
  { id: 'system', label: 'System and tools', color: 'var(--c-system)', cats: ['system', 'tools'] },
  { id: 'instructions', label: 'Instructions', color: 'var(--c-instr)', cats: ['context'] },
  { id: 'handoff', label: 'Handoff', color: 'var(--c-handoff)', cats: ['checkpoint'] },
  { id: 'messages', label: 'Messages', color: 'var(--c-msg)', cats: ['user', 'assistant', 'conductor'] },
  { id: 'tools', label: 'Tool results', color: 'var(--c-tool)', cats: ['tool'] },
]

const GROUP_OF = {}
for (const g of GROUPS) for (const c of g.cats) GROUP_OF[c] = g

export function groupOf(category) {
  return GROUP_OF[category] || GROUPS[3]
}

/** Row kind label of one inventory item. */
export function kindLabel(item) {
  switch (item && item.category) {
    case 'system': return 'System prompt'
    case 'tool': return 'Tool result'
    case 'assistant': return 'Assistant'
    case 'user': return 'You'
    case 'conductor': return 'Conductor notice'
    case 'checkpoint': return 'Handoff'
    case 'context': return 'Instructions'
    default: return 'Item'
  }
}

/**
 * Meter numbers from view.meter.
 * @returns {{ total, window, percent, free, segments: [{ id, label, color, tokens }] }}
 */
export function meterModel(meter) {
  const cats = (meter && meter.categories) || {}
  const total = Number(meter && meter.total) || 0
  const win = Number(meter && meter.window) || 0
  const segments = GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    color: g.color,
    tokens: g.cats.reduce((sum, c) => sum + (Number(cats[c]) || 0), 0),
  }))
  const percent = win > 0 ? Math.min(100, Math.round((total / win) * 100)) : null
  return { total, window: win || null, percent, free: win > 0 ? Math.max(0, win - total) : null, segments }
}

/** Meter level against the configured warning percent. */
export function meterLevel(percent, warnPercent = 80) {
  if (percent === null || percent === undefined) return 'ok'
  if (percent >= warnPercent) return 'bad'
  if (percent >= Math.max(0, warnPercent - 20)) return 'warn'
  return 'ok'
}

// ── drop selection ─────────────────────────────────────────────────────

/** Why an item cannot be ticked, or '' when it can. */
export function dropBlocker(item) {
  if (!item) return 'Unknown item.'
  if (item.pinned) return 'Pinned. Unpin to drop.'
  if (item.pendingDrop) return 'Already queued: it leaves the context when the next turn starts.'
  if (item.dropped) return 'Already dropped.'
  if (item.index === 0 || item.category === 'system') return 'The system prompt is never dropped.'
  if (!item.droppable) return item.category === 'checkpoint' ? 'The handoff stays until the next reset.' : 'This item cannot be dropped.'
  return ''
}

/**
 * What a drop of the ticked rows will remove. An assistant step takes its
 * tool results with it (the host expands it the same way), so the saving
 * counts those too, without double counting a tool result ticked as well.
 * @param items view.items (surface order)
 * @param selected iterable of seqs
 * @returns {{ count, tokens, seqs: number[], expanded: number[] }}
 */
export function selectionTotal(items, selected) {
  const list = Array.isArray(items) ? items : []
  const want = new Set([...(selected || [])].map(Number))
  const order = list.map((i) => i.seq)
  const bySeq = new Map(list.map((i) => [i.seq, i]))
  const covered = new Set()
  const seqs = []
  for (const seq of order) {
    if (!want.has(seq)) continue
    const item = bySeq.get(seq)
    if (!item || dropBlocker(item)) continue
    seqs.push(seq)
    covered.add(seq)
    if (item.category === 'assistant') {
      for (let i = order.indexOf(seq) + 1; i < order.length; i += 1) {
        const next = bySeq.get(order[i])
        if (!next || next.category !== 'tool') break
        covered.add(next.seq)
      }
    }
  }
  let tokens = 0
  for (const s of covered) tokens += Number(bySeq.get(s).tokens) || 0
  return { count: seqs.length, tokens, seqs, expanded: [...covered].sort((a, b) => a - b) }
}

/** Sort the inspector rows. */
export function sortItems(items, mode) {
  const list = [...(items || [])]
  if (mode === 'age') return list.sort((a, b) => a.seq - b.seq)
  if (mode === 'newest') return list.sort((a, b) => b.seq - a.seq)
  if (mode === 'type') {
    const rank = (i) => GROUPS.indexOf(groupOf(i.category))
    return list.sort((a, b) => rank(a) - rank(b) || (b.tokens - a.tokens))
  }
  return list.sort((a, b) => (b.tokens - a.tokens) || (a.seq - b.seq))
}

// ── drop result copy ───────────────────────────────────────────────────

/** Toast copy for a drop response (numbers first, honest about queued items). */
export function dropMessage(result) {
  const r = result || {}
  const dropped = Number(r.dropped) || 0
  const queued = Number(r.queued) || 0
  const parts = []
  if (dropped > 0) parts.push('Dropped ' + dropped + ' ' + plural(dropped, 'item') + '.')
  if (queued > 0) parts.push(queued + ' tool ' + plural(queued, 'output') + ' ' + (queued === 1 ? 'leaves' : 'leave') + ' the context when the next turn starts.')
  if (parts.length && Number.isFinite(r.tokens)) parts.push(fmtTokens(r.tokens) + ' tokens freed.')
  const steps = dropped - (Array.isArray(r.undoable) ? r.undoable.length : dropped)
  if (steps > 0) parts.push(steps === 1 ? 'The assistant step cannot be put back; its original is saved.' : steps + ' assistant steps cannot be put back; their originals are saved.')
  if (!parts.length) return r.text || 'Nothing was dropped.'
  const skipped = Array.isArray(r.skipped) ? r.skipped : []
  if (skipped.length) {
    const reasons = [...new Set(skipped.map((s) => s && s.reason).filter(Boolean))]
    parts.push('Skipped ' + skipped.length + (reasons.length ? ': ' + reasons.join('; ') : '') + '.')
  }
  return parts.join(' ')
}

// ── word diff ──────────────────────────────────────────────────────────

/**
 * Word-level diff of two texts. Whitespace runs are tokens too, so joining
 * the 'same' + 'add' parts gives `b` and 'same' + 'del' gives `a`.
 * LCS on the middle part after trimming the common prefix and suffix; a
 * very large middle falls back to one deletion plus one addition.
 * @returns {Array<{ type: 'same'|'add'|'del', text: string }>}
 */
export function wordDiff(a, b, limit = 1600) {
  const A = String(a || '').split(/(\s+)/).filter((t) => t !== '')
  const B = String(b || '').split(/(\s+)/).filter((t) => t !== '')
  let start = 0
  while (start < A.length && start < B.length && A[start] === B[start]) start += 1
  let endA = A.length
  let endB = B.length
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA -= 1; endB -= 1 }
  const out = []
  const push = (type, text) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.type === type) last.text += text
    else out.push({ type, text })
  }
  push('same', A.slice(0, start).join(''))
  const midA = A.slice(start, endA)
  const midB = B.slice(start, endB)
  if (midA.length > limit || midB.length > limit) {
    push('del', midA.join(''))
    push('add', midB.join(''))
  } else {
    const n = midA.length
    const m = midB.length
    // dp[i][j] = LCS length of midA[i:] and midB[j:]
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { push('same', midA[i]); i += 1; j += 1 }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', midA[i]); i += 1 }
      else { push('add', midB[j]); j += 1 }
    }
    while (i < n) { push('del', midA[i]); i += 1 }
    while (j < m) { push('add', midB[j]); j += 1 }
  }
  push('same', A.slice(endA).join(''))
  return groupChanges(out)
}

/**
 * Readability pass: inside one run of changes (only whitespace in common),
 * show every deletion first and then every addition, instead of word by word
 * interleaving. Whitespace shared inside the run goes to both sides, so the
 * round trip (same + del = a, same + add = b) still holds.
 */
function groupChanges(parts) {
  const out = []
  let del = ''
  let add = ''
  let changed = false
  let pendingWs = ''
  const flush = () => {
    if (changed) {
      if (del) out.push({ type: 'del', text: del })
      if (add) out.push({ type: 'add', text: add })
    }
    del = ''
    add = ''
    changed = false
  }
  const pushSame = (text) => {
    const last = out[out.length - 1]
    if (last && last.type === 'same') last.text += text
    else out.push({ type: 'same', text })
  }
  for (const p of parts) {
    if (p.type === 'same' && /^\s+$/.test(p.text) && changed) { pendingWs += p.text; continue }
    if (p.type === 'same') {
      // whitespace that ended a change run belongs to the shared text after it
      flush()
      pushSame(pendingWs + p.text)
      pendingWs = ''
      continue
    }
    if (pendingWs) { del += pendingWs; add += pendingWs; pendingWs = '' }
    changed = true
    if (p.type === 'del') del += p.text
    else add += p.text
  }
  flush()
  if (pendingWs) pushSame(pendingWs)
  return out
}

/** Approximate token delta between two texts (chars / 4, like the host's pin cost). */
export function tokenDelta(a, b) {
  return Math.round((String(b || '').length - String(a || '').length) / 4)
}

/** Epoch kind label. */
export function epochLabel(kind) {
  switch (kind) {
    case 'new': return '/new'
    case 'clear': return '/clear'
    case 'force-compact': return '/force-compact'
    case 'pointer': return 'Pointer compaction'
    case 'compact': return 'Auto compaction'
    case 'rewind': return 'Rewind'
    default: return String(kind || 'Reset')
  }
}

export function byLabel(by) {
  if (by === 'model') return 'by the assistant'
  if (by === 'auto') return 'automatic'
  if (by === 'script') return 'by a script'
  if (by === 'schedule') return 'scheduled'
  if (by === 'recovery') return 'by recovery'
  return 'by you'
}

/** Reset progress title. */
export function resetTitle(kind) {
  switch (kind) {
    case 'new': return 'Writing handoff'
    case 'clear': return 'Clearing context'
    case 'pointer': return 'Writing a pointer checkpoint'
    default: return 'Compacting context'
  }
}
