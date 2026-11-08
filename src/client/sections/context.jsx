/**
 * Context section: every item the model sees, sorted by size, with ticks,
 * a sticky "Drop N items (34.1K)" footer, inline previews, edits, and the
 * honest dropped / queued states (UX spec A5).
 *
 * Tool outputs dropped while the chat is idle are queued by the host and
 * leave the context when the next turn starts (stored-log rule): those rows
 * come back with pendingDrop and say so. Message and step drops apply at once.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  fmtTokens, fmtAgo, groupOf, kindLabel, GROUPS, selectionTotal, sortItems, dropBlocker, dropMessage, plural,
} from '../format.js'
import { Icon, IconButton, Empty, copyText } from '../ui.jsx'
import { toast, toastError } from '../toasts.jsx'

const PAGE = 25
const SIMPLE = 8

function isEditable(item) {
  return Boolean(item.messageId) && !item.dropped && !item.pendingDrop && (item.category === 'user' || item.category === 'assistant')
}

/** Undo a drop: put the applied items back and cancel the queued ones when that is safe. */
export async function undoDrop(api, model, result) {
  const parts = []
  if (Array.isArray(result.undoable) && result.undoable.length) {
    const r = await api.undrop(result.undoable)
    const n = (r.restored || 0) + (r.queued || 0)
    if (n) parts.push('Put back ' + n + ' ' + plural(n, 'item') + '.')
  }
  if (result.queued > 0) {
    // queued tool outputs have not left the context yet: cancel them
    const r = await api.undrop('pending')
    const n = Number(r.cancelled) || 0
    if (n) parts.push('Cancelled ' + n + ' queued ' + plural(n, 'drop') + ': nothing had left the context yet.')
  }
  model.refresh().catch(() => {})
  return parts.join(' ') || 'Nothing to put back.'
}

function ItemDetail({ item, api, model, sessionId, onPinToggle }) {
  const [full, setFull] = useState(null)
  const [loading, setLoading] = useState(false)
  const [edit, setEdit] = useState(null) // { text, reason }
  const [saving, setSaving] = useState(false)
  const text = full !== null ? full : item.preview || ''
  const truncated = full === null && (item.chars > (item.preview || '').length + 40 || (item.preview || '').length >= 240)

  const loadFull = async () => {
    setLoading(true)
    try {
      const r = await api.item(item.seq)
      setFull(String(r.text || ''))
      return String(r.text || '')
    } catch (e) {
      toastError('Could not load the full item.', e, sessionId)
      return null
    } finally { setLoading(false) }
  }

  const startEdit = async () => {
    const t = full !== null ? full : await loadFull()
    if (t !== null) setEdit({ text: t, reason: '' })
  }

  const saveEdit = async () => {
    setSaving(true)
    try {
      const r = await api.edit(item.messageId, edit.text, edit.reason.trim() || undefined)
      toast({ message: 'Saved version ' + r.version + '. The model sees the new text from its next step; every version is kept in History.', sessionId })
      setEdit(null)
      setFull(null)
      model.refresh().catch(() => {})
    } catch (e) {
      toastError('Could not save the edit.', e, sessionId)
    } finally { setSaving(false) }
  }

  if (edit) {
    return (
      <div className="cdx-detail" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <label className="cdx-field"><span>New text (the chat shows it with a version marker; every version is kept)</span>
          <textarea className="cdx-in" rows={6} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} autoFocus />
        </label>
        <label className="cdx-field"><span>Reason (optional)</span>
          <input className="cdx-in" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} placeholder="for example: removed a wrong assumption" />
        </label>
        <div className="cdx-btnrow">
          <button type="button" className="cdx-btn p s" disabled={saving || !edit.text.trim()} onClick={saveEdit}>{saving ? 'Saving\u2026' : 'Save version'}</button>
          <button type="button" className="cdx-btn s g" onClick={() => setEdit(null)}>Cancel</button>
        </div>
      </div>
    )
  }
  return (
    <div className="cdx-detail" onClick={(e) => e.stopPropagation()}>
      {text ? <pre className={'cdx-pre' + (full === null ? ' short' : '')} data-preview>{full !== null && full.length > 200000 ? full.slice(0, 200000) : text}</pre>
        : <span className="cdx-help">No text content (tool calls or images only).</span>}
      <div className="cdx-btnrow">
        {truncated ? <button type="button" className="cdx-btn s" disabled={loading} onClick={loadFull}>{loading ? 'Loading\u2026' : 'Show all'}</button> : null}
        <button type="button" className="cdx-btn s g" onClick={async () => { const ok = await copyText(full !== null ? full : (await loadFull()) || text); toast({ message: ok ? 'Copied ' + kindLabel(item).toLowerCase() + ' text.' : 'Copy is not available in this browser.', sessionId }) }}>{Icon.copy(13)}Copy</button>
        {item.messageId && (item.category === 'user' || item.category === 'assistant') && !item.dropped ? (
          <button type="button" className="cdx-btn s g" onClick={() => onPinToggle(item)}>{Icon.pin(13)}{item.pinned ? 'Unpin' : 'Pin'}</button>
        ) : null}
        {isEditable(item) ? <button type="button" className="cdx-btn s g" onClick={startEdit}>{Icon.edit(13)}Edit</button> : null}
      </div>
    </div>
  )
}

function ItemRow({ item, max, ticked, focused, expanded, edited, onTick, onToggle, onFocusRow, rowRef, onUndrop, detail }) {
  const g = groupOf(item.category)
  const blocker = dropBlocker(item)
  const tickable = !blocker
  const leaving = item.pendingDrop
  const meta = [kindLabel(item)]
  if (item.tool && item.category === 'tool') meta[0] = 'Tool result'
  const age = fmtAgo(item.time)
  const title = item.label || '(empty)'
  return (
    <li>
      <div className={'cdx-row click' + (ticked ? ' ticked' : '') + (item.dropped || leaving ? ' gone' : '') + (expanded ? ' open' : '')}
        ref={rowRef} tabIndex={focused ? 0 : -1} data-seq={item.seq} aria-expanded={expanded}
        onClick={onToggle} onFocus={onFocusRow} style={{ gridTemplateColumns: '18px minmax(0,1fr) auto' }}>
        <label className="cdx-check" onClick={(e) => e.stopPropagation()} title={blocker || undefined}>
          <input type="checkbox" checked={ticked} disabled={!tickable} tabIndex={-1}
            aria-label={'Select ' + title.slice(0, 80) + ', ' + fmtTokens(item.tokens) + ' tokens'}
            onChange={() => onTick()} />
        </label>
        <div className="cdx-main">
          <div className="cdx-title">
            <span className="cdx-sw" style={{ background: g.color }} aria-hidden="true" />
            {item.pinned ? <span style={{ color: 'var(--clay)', display: 'inline-flex' }} title="Pinned" aria-label="Pinned">{Icon.pin(12)}</span> : null}
            <span title={title}>{title}</span>
          </div>
          <div className="cdx-meta">
            <span>{meta.join(' \u00b7 ') + (age ? ' \u00b7 ' + age : '')}</span>
            {item.dropped ? <span className="cdx-chip">Dropped</span> : null}
            {leaving ? <span className="cdx-chip warn" title="Tool outputs dropped between turns leave the context when the next turn starts.">Leaves at next turn</span> : null}
            {edited ? <span className="cdx-chip" title="The model sees an edited version; see Versions.">Edited</span> : null}
          </div>
        </div>
        <div className="cdx-side">
          {item.dropped && item.dropped.undoable ? (
            <button type="button" className="cdx-btn s" onClick={(e) => { e.stopPropagation(); onUndrop(item) }}>Undrop</button>
          ) : null}
          <span className="cdx-size">
            <span className="cdx-num">{fmtTokens(item.tokens)}</span>
            <span className="cdx-mini" aria-hidden="true"><i style={{ width: Math.max(2, Math.round((item.tokens / (max || 1)) * 100)) + '%', background: g.color }} /></span>
          </span>
        </div>
        {expanded ? detail : null}
      </div>
    </li>
  )
}

/** Put one dropped item back. */
export async function undropItem(api, model, item, sessionId) {
  try {
    const r = await api.undrop(item.dropped.id)
    toast({ message: r.queued ? 'It comes back when the next turn starts.' : 'Put back ' + (r.restored || 1) + ' ' + plural(r.restored || 1, 'item') + '.', sessionId })
  } catch (e) {
    toastError('Could not put it back.', e, sessionId)
  } finally { model.refresh().catch(() => {}) }
}

/** Pin or unpin a message item, with Undo. */
export async function togglePin(api, model, item, sessionId) {
  try {
    if (item.pinned) {
      const r = await api.unpin(item.messageId)
      const pin = r.pin || {}
      toast({ message: 'Unpinned. ' + fmtTokens(pin.tokens || 0) + ' tokens leave the context at the next reset.', sessionId, undo: async () => { await api.pin(item.messageId, pin.note); model.refresh().catch(() => {}); return 'Pinned again.' } })
    } else {
      const r = await api.pin(item.messageId)
      toast({ message: 'Pinned. ' + fmtTokens((r.pin && r.pin.tokens) || 0) + ' tokens, kept across /new and /clear.', sessionId, undo: async () => { await api.unpin(item.messageId); model.refresh().catch(() => {}); return 'Unpinned.' } })
    }
  } catch (e) {
    toastError(item.pinned ? 'Could not unpin.' : 'Could not pin.', e, sessionId)
  } finally { model.refresh().catch(() => {}) }
}

/** Drop one item (the simple view's per-row button), with Undo. */
export async function dropOne(api, model, item, sessionId) {
  model.patch((v) => ({ ...v, items: v.items.map((i) => (i.seq === item.seq ? { ...i, pendingDrop: true } : i)) }))
  try {
    const result = await api.drop([item.seq])
    const canUndo = (Array.isArray(result.undoable) && result.undoable.length > 0) || result.queued > 0
    toast({ message: dropMessage(result), sessionId, undo: canUndo ? () => undoDrop(api, model, result) : null })
  } catch (e) {
    toastError('Could not drop it.', e, sessionId)
  } finally { model.refresh().catch(() => {}) }
}

const pinnable = (item) => Boolean(item.messageId) && !item.dropped && (item.category === 'user' || item.category === 'assistant')

/** Default view: the biggest items, one Drop button each. */
export function SimpleContext({ sessionId, view, api, model, filter, onFilter, busyAgent, onAdvanced }) {
  const items = view.items || []
  const [expanded, setExpanded] = useState(null)
  const list = useMemo(() => sortItems(filter ? items.filter((i) => groupOf(i.category).id === filter) : items, 'size').slice(0, SIMPLE), [items, filter])
  if (!items.length) return <Empty title="Context is empty">Send a message and what the model sees will be listed here, biggest first.</Empty>
  const filterGroup = filter ? GROUPS.find((g) => g.id === filter) : null
  return (
    <div>
      <div className="cdx-phead">
        <span className="cdx-help">{filterGroup ? filterGroup.label : 'Biggest items'}</span>
        {filterGroup ? <button type="button" className="cdx-link" onClick={() => onFilter(null)}>Show every type</button> : null}
      </div>
      <ul className="cdx-list plain" aria-label="Biggest context items">
        {list.map((item) => {
          const g = groupOf(item.category)
          const blocker = dropBlocker(item)
          const open = expanded === item.seq
          return (
            <li key={item.seq}>
              <div className={'cdx-row click' + (item.dropped || item.pendingDrop ? ' gone' : '') + (open ? ' open' : '')} tabIndex={0} data-seq={item.seq}
                aria-expanded={open} onClick={() => setExpanded(open ? null : item.seq)}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setExpanded(open ? null : item.seq) } }}
                style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <div className="cdx-main">
                  <div className="cdx-title">
                    <span className="cdx-sw" style={{ background: g.color }} aria-hidden="true" />
                    {item.pinned ? <span className="cdx-pinmark" title="Pinned" aria-label="Pinned">{Icon.pin(12)}</span> : null}
                    <span title={item.label}>{item.label || '(empty)'}</span>
                  </div>
                  <div className="cdx-meta">
                    <span>{kindLabel(item) + (item.time ? ' \u00b7 ' + fmtAgo(item.time) : '')}</span>
                    {item.dropped ? <span className="cdx-chip">Dropped</span> : null}
                    {item.pendingDrop ? <span className="cdx-chip warn" title="Tool outputs dropped between turns leave the context when the next turn starts.">Leaves at next turn</span> : null}
                  </div>
                </div>
                <div className="cdx-side">
                  <span className="cdx-num cdx-sizenum" title={fmtTokens(item.tokens) + ' tokens'}>{fmtTokens(item.tokens)}</span>
                  <span className="cdx-acts">
                    {pinnable(item) ? (
                      <IconButton label={item.pinned ? 'Unpin' : 'Pin to context'} pressed={item.pinned} className={item.pinned ? 'on' : ''}
                        onClick={() => togglePin(api, model, item, sessionId)}>{Icon.pin(13)}</IconButton>
                    ) : null}
                  </span>
                  {item.dropped && item.dropped.undoable ? (
                    <button type="button" className="cdx-btn s g" onClick={(e) => { e.stopPropagation(); undropItem(api, model, item, sessionId) }}>Undrop</button>
                  ) : blocker ? <span className="cdx-drop1" aria-hidden="true" /> : (
                    <button type="button" className="cdx-btn s g cdx-drop1" data-drop-one={item.seq}
                      disabled={busyAgent} title={busyAgent ? 'The agent is working. Drop when it has finished.' : 'Remove from the model context (the chat keeps it)'}
                      onClick={(e) => { e.stopPropagation(); dropOne(api, model, item, sessionId) }}>Drop</button>
                  )}
                </div>
                {open ? <ItemDetail item={item} api={api} model={model} sessionId={sessionId} onPinToggle={(it) => togglePin(api, model, it, sessionId)} /> : null}
              </div>
            </li>
          )
        })}
      </ul>
      <div className="cdx-panelfoot">
        <button type="button" className="cdx-link" data-show-all onClick={() => onAdvanced(false)}>{'Show all ' + items.length + ' ' + plural(items.length, 'item')}</button>
        <button type="button" className="cdx-link" data-select-several onClick={() => onAdvanced(true)}>Select several</button>
      </div>
    </div>
  )
}

/** The Context sub-tab: the simple view, or the full inspector on demand. */
export function ContextPanel(props) {
  const [advanced, setAdvanced] = useState(null) // null | { select: boolean }
  const undroppable = (props.view.items || []).some((i) => i.dropped && i.dropped.undoable)
  if (!advanced) return <SimpleContext {...props} onAdvanced={(select) => setAdvanced({ select })} />
  return <ContextSection {...props} focusSelect={advanced.select} undroppable={undroppable} onSimple={() => setAdvanced(null)} />
}

export function ContextSection({ sessionId, view, api, model, filter, onFilter, busyAgent, onSimple, focusSelect, undroppable }) {
  const items = view.items || []
  const [selected, setSelected] = useState(() => new Set())
  const [sort, setSort] = useState('size')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [showAll, setShowAll] = useState(false)
  const [focusSeq, setFocusSeq] = useState(null)
  const [anchor, setAnchor] = useState(null)
  const [dropping, setDropping] = useState(false)
  const rowRefs = useRef(new Map())

  // forget ticks of items that left the surface
  useEffect(() => {
    const live = new Set(items.map((i) => i.seq))
    setSelected((prev) => {
      let changed = false
      const next = new Set()
      for (const s of prev) { if (live.has(s) && !dropBlocker(items.find((i) => i.seq === s))) next.add(s); else changed = true }
      return changed ? next : prev
    })
  }, [view.fingerprint])

  const filtered = useMemo(() => {
    let list = items
    if (filter) list = list.filter((i) => groupOf(i.category).id === filter)
    const q = query.trim().toLowerCase()
    if (q) list = list.filter((i) => (i.label || '').toLowerCase().includes(q) || (i.tool || '').toLowerCase().includes(q) || (i.preview || '').toLowerCase().includes(q))
    return sortItems(list, sort)
  }, [items, filter, query, sort])
  const visible = showAll ? filtered : filtered.slice(0, PAGE)
  const max = useMemo(() => items.reduce((m, i) => Math.max(m, i.tokens || 0), 0), [items])
  const total = useMemo(() => selectionTotal(items, selected), [items, selected])
  const editedSeqs = useMemo(() => new Set((view.versions || []).map((v) => v.replacementSeq).filter((x) => Number.isFinite(x))), [view.versions])
  const tickableVisible = visible.filter((i) => !dropBlocker(i))
  const allTicked = tickableVisible.length > 0 && tickableVisible.every((i) => selected.has(i.seq))
  const someTicked = tickableVisible.some((i) => selected.has(i.seq))
  const focusedSeq = focusSeq !== null && visible.some((i) => i.seq === focusSeq) ? focusSeq : (visible[0] && visible[0].seq)

  const toggle = (seq, on) => setSelected((prev) => {
    const next = new Set(prev)
    const want = on === undefined ? !next.has(seq) : on
    if (want) next.add(seq); else next.delete(seq)
    return next
  })
  const selectAll = (on) => setSelected(on ? new Set(tickableVisible.map((i) => i.seq)) : new Set())

  const focusRow = (seq) => {
    setFocusSeq(seq)
    const el = rowRefs.current.get(seq)
    if (el) el.focus()
  }

  const drop = async () => {
    if (!total.count || dropping) return
    if (busyAgent) { toast({ tone: 'error', message: 'The agent is working. Drop again when it has finished.', sessionId }); return }
    setDropping(true)
    const seqs = total.seqs
    model.patch((v) => ({ ...v, items: v.items.map((i) => (total.expanded.includes(i.seq) ? { ...i, pendingDrop: true } : i)) }))
    try {
      const result = await api.drop(seqs)
      setSelected(new Set())
      setExpanded(null)
      const canUndo = (Array.isArray(result.undoable) && result.undoable.length > 0) || result.queued > 0
      toast({ message: dropMessage(result), sessionId, undo: canUndo ? () => undoDrop(api, model, result) : null })
    } catch (e) {
      toastError('Could not drop the items.', e, sessionId)
    } finally {
      setDropping(false)
      model.refresh().catch(() => {})
    }
  }

  const undropOne = (item) => undropItem(api, model, item, sessionId)
  const pinToggle = (item) => togglePin(api, model, item, sessionId)

  const onKeyDown = (e) => {
    if (e.target.closest && e.target.closest('input,textarea,select,[contenteditable=true]') && e.target.type !== 'checkbox') return
    const idx = visible.findIndex((i) => i.seq === focusedSeq)
    if (idx < 0) return
    const item = visible[idx]
    const key = e.key
    const mod = e.ctrlKey || e.metaKey
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault()
      const next = visible[Math.max(0, Math.min(visible.length - 1, idx + (key === 'ArrowDown' ? 1 : -1)))]
      if (e.shiftKey) {
        const from = anchor === null ? item.seq : anchor
        if (anchor === null) setAnchor(item.seq)
        const a = visible.findIndex((i) => i.seq === from)
        const b = visible.findIndex((i) => i.seq === next.seq)
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected((prev) => {
          const s = new Set(prev)
          for (let k = lo; k <= hi; k += 1) if (!dropBlocker(visible[k])) s.add(visible[k].seq)
          return s
        })
      } else setAnchor(null)
      focusRow(next.seq)
    } else if (key === 'Home' || key === 'End') {
      e.preventDefault()
      focusRow((key === 'Home' ? visible[0] : visible[visible.length - 1]).seq)
    } else if ((key === 'x' || key === 'X' || key === ' ') && !mod) {
      e.preventDefault()
      if (!dropBlocker(item)) toggle(item.seq)
    } else if (key === 'Enter') {
      e.preventDefault()
      setExpanded(expanded === item.seq ? null : item.seq)
    } else if (key === 'Delete' || key === 'Backspace') {
      if (total.count) { e.preventDefault(); drop() }
    } else if (mod && (key === 'a' || key === 'A')) {
      e.preventDefault()
      selectAll(true)
    } else if (key === 'Escape') {
      if (expanded !== null || selected.size) { e.preventDefault(); e.stopPropagation(); setExpanded(null); setSelected(new Set()) }
    }
  }

  if (!items.length) {
    return <Empty title="Context is empty">Send a message and every item the model sees will be listed here with its size.</Empty>
  }

  const filterGroup = filter ? GROUPS.find((g) => g.id === filter) : null
  return (
    <div onKeyDown={onKeyDown}>
      <div className="cdx-tools">
        <label title={allTicked ? 'Clear selection' : 'Select every droppable item shown'}>
          <input type="checkbox" autoFocus={Boolean(focusSelect)} checked={allTicked} ref={(el) => { if (el) el.indeterminate = !allTicked && someTicked }}
            disabled={!tickableVisible.length} onChange={() => selectAll(!allTicked)} style={{ accentColor: 'var(--clay)', margin: 0 }} />
          All
        </label>
        <select className="cdx-in s" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort items">
          <option value="size">Largest first</option>
          <option value="newest">Newest first</option>
          <option value="age">Oldest first</option>
          <option value="type">By type</option>
        </select>
        {filterGroup ? (
          <button type="button" className="cdx-chipbtn" aria-pressed="true" onClick={() => onFilter(null)} aria-label={'Remove filter ' + filterGroup.label}>
            <span className="cdx-sw" style={{ background: filterGroup.color }} />{filterGroup.label}{Icon.close(10)}
          </button>
        ) : null}
        {items.length >= 25 ? (
          <input className="cdx-in s" style={{ flex: '1 1 90px', width: 'auto', minWidth: 80 }} type="search" placeholder="Search items" aria-label="Search context items"
            value={query} onChange={(e) => setQuery(e.target.value)} />
        ) : <span className="cdx-spacer" />}
        {filter || query.trim() ? <span className="cdx-help cdx-num" aria-live="polite">{filtered.length + ' of ' + items.length}</span> : null}
        {onSimple ? <button type="button" className="cdx-link" data-simple-view onClick={onSimple}>Fewer</button> : null}
      </div>
      {undroppable ? (
        <div className="cdx-phead"><span className="cdx-spacer" /><button type="button" className="cdx-link" onClick={async () => {
          try { const r = await api.undrop('all'); toast({ message: r.text || 'Put back every dropped item.', sessionId }) } catch (e) { toastError('Could not put the items back.', e, sessionId) } finally { model.refresh().catch(() => {}) }
        }}>Undrop all</button></div>
      ) : null}
      {filtered.length === 0 ? <div className="cdx-empty">No items match. <button type="button" className="cdx-link" onClick={() => { setQuery(''); onFilter(null) }}>Show every item</button></div> : null}
      <ul className="cdx-list" aria-label="Context items">
        {visible.map((item) => (
          <ItemRow key={item.seq} item={item} max={max} ticked={selected.has(item.seq)} focused={item.seq === focusedSeq}
            expanded={expanded === item.seq} edited={editedSeqs.has(item.seq)}
            rowRef={(el) => { if (el) rowRefs.current.set(item.seq, el); else rowRefs.current.delete(item.seq) }}
            onFocusRow={() => setFocusSeq(item.seq)}
            onTick={() => toggle(item.seq)}
            onToggle={() => { setFocusSeq(item.seq); setExpanded(expanded === item.seq ? null : item.seq) }}
            onUndrop={undropOne}
            detail={expanded === item.seq ? <ItemDetail item={item} api={api} model={model} sessionId={sessionId} onPinToggle={pinToggle} /> : null} />
        ))}
      </ul>
      {!showAll && filtered.length > PAGE ? (
        <div className="cdx-more"><button type="button" className="cdx-btn s" onClick={() => setShowAll(true)}>{'Show all ' + filtered.length}</button></div>
      ) : null}
      {total.count > 0 ? (
        <div className="cdx-foot" data-drop-footer>
          <span className="cdx-grow cdx-num" aria-live="polite">{total.count + ' selected, ' + fmtTokens(total.tokens)}</span>
          <button type="button" className="cdx-btn s g" onClick={() => setSelected(new Set())}>Clear selection</button>
          <button type="button" className="cdx-btn s d" data-drop disabled={dropping} onClick={drop}
            title="Remove the ticked items from the model context. The chat keeps them, and originals are saved.">
            {'Drop ' + total.count + ' ' + plural(total.count, 'item') + ' (' + fmtTokens(total.tokens) + ')'}
          </button>
        </div>
      ) : null}
    </div>
  )
}


