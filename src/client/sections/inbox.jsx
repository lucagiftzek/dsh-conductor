/**
 * Inbox section (UX spec A8): silent messages from other chats and scripts
 * that did not wake the agent, plus the "Post to another chat" form.
 *
 * Dismiss is a soft hide on the host, so its Undo (undismiss) is exact.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { fmtAgo, firstLine, plural, shortId } from '../format.js'
import { Icon, IconButton, Empty, Note, useSignal } from '../ui.jsx'
import { toast, toastError } from '../toasts.jsx'
import { createSignal, statusModel, refreshStatus } from '../store.js'
import { postToChat, errorText } from '../api.js'

/** ids hidden at once while their dismissal is in flight (no flicker before the refresh). */
export const hiddenInbox = createSignal(new Set())

function hide(ids, on) {
  const next = new Set(hiddenInbox.get())
  for (const id of ids) { if (on) next.add(id); else next.delete(id) }
  hiddenInbox.set(next)
}

/** Dismiss (a soft hide on the host) with an Undo that brings the messages back. */
export async function dismissWithUndo(api, model, ids, sessionId) {
  if (!ids.length) return
  hide(ids, true)
  try {
    await api.inbox('dismiss', ids)
    toast({
      message: 'Dismissed ' + ids.length + ' ' + plural(ids.length, 'message') + '.',
      sessionId,
      undo: async () => {
        await api.inbox('undismiss', ids)
        await model.refresh().catch(() => {})
        hide(ids, false)
        return 'Restored ' + ids.length + ' ' + plural(ids.length, 'message') + ' to the inbox.'
      },
    })
    await model.refresh().catch(() => {})
  } catch (e) {
    toastError('Could not dismiss.', e, sessionId)
  } finally {
    hide(ids, false)
  }
}


export async function markAllRead(api, model, view, sessionId) {
  const ids = (view.inbox || []).filter((e) => !e.read).map((e) => e.id)
  if (!ids.length) return
  try {
    await api.inbox('read', ids)
    toast({
      message: 'Marked ' + ids.length + ' ' + plural(ids.length, 'message') + ' read.',
      sessionId,
      undo: async () => { await api.inbox('unread', ids); model.refresh().catch(() => {}); return 'Marked ' + ids.length + ' unread again.' },
    })
  } catch (e) {
    toastError('Could not mark the messages read.', e, sessionId)
  } finally { model.refresh().catch(() => {}) }
}

function deliveredLabel(entry) {
  if (entry.visible === 'user') return 'Visible to you only'
  if (entry.delivered === 'appended') return 'In the model context'
  if (entry.delivered === 'next-step') return 'Given to the model at its next step'
  if (typeof entry.delivered === 'string' && entry.delivered.startsWith('failed')) return 'Not delivered to the model'
  return ''
}

function InboxRow({ entry, open, focused, onToggle, onFocusRow, rowRef, api, model, sessionId, openSession, openFile }) {
  const add = async () => {
    try {
      const r = await api.inbox('add', [entry.id])
      toast({ message: r.delivered === 'next-step' ? 'Added. The model sees it at its next step.' : 'Added to the model context.', sessionId })
    } catch (e) { toastError('Could not add it to the context.', e, sessionId) } finally { model.refresh().catch(() => {}) }
  }
  const markUnread = async () => {
    try { await api.inbox('unread', [entry.id]); onToggle(false) } catch (e) { toastError('Could not mark it unread.', e, sessionId) } finally { model.refresh().catch(() => {}) }
  }
  const label = deliveredLabel(entry)
  return (
    <li>
      <div className={'cdx-row click' + (entry.read ? ' muted' : ' unread') + (open ? ' open' : '')} ref={rowRef} tabIndex={focused ? 0 : -1}
        data-inbox={entry.id} aria-expanded={open} onClick={() => onToggle()} onFocus={onFocusRow}>
        <span className={'cdx-dot' + (entry.read ? '' : ' live')} style={entry.read ? { background: 'transparent' } : undefined}
          aria-label={entry.read ? undefined : 'Unread'} role={entry.read ? undefined : 'img'} />
        <div className="cdx-main">
          <div className="cdx-title"><span>{firstLine(entry.text, 120) || '(empty message)'}</span></div>
          <div className="cdx-meta">
            <span className="cdx-chip" title={entry.from && entry.from.sessionId ? entry.from.sessionId : undefined}>{(entry.from && entry.from.label) || 'unknown'}</span>
            {entry.kind && entry.kind !== 'note' ? <span className={'cdx-chip' + (entry.kind === 'alert' ? ' bad' : '')}>{entry.kind}</span> : null}
            <span>{fmtAgo(entry.at)}</span>
          </div>
        </div>
        <div className="cdx-side">
          <span className="cdx-acts">
            {entry.from && entry.from.sessionId ? <IconButton label="Open source chat" onClick={() => openSession(entry.from.sessionId)}>{Icon.open(13)}</IconButton> : null}
            <IconButton label="Dismiss" onClick={() => dismissWithUndo(api, model, [entry.id], sessionId)}>{Icon.close(12)}</IconButton>
          </span>
        </div>
        {open ? (
          <div className="cdx-detail" onClick={(e) => e.stopPropagation()}>
            <div className="cdx-text">{entry.text}</div>
            {label ? <span className="cdx-help">{label}</span> : null}
            <div className="cdx-btnrow">
              <button type="button" className="cdx-btn s" onClick={add} title="Give this message to the model again">{Icon.inject(13)}Add to context</button>
              {entry.from && entry.from.sessionId ? <button type="button" className="cdx-btn s g" onClick={() => openSession(entry.from.sessionId)}>{Icon.open(13)}Open source chat</button> : null}
              {entry.file ? <button type="button" className="cdx-btn s g" onClick={() => openFile(entry.file)}>Full text</button> : null}
              <button type="button" className="cdx-btn s g" onClick={markUnread}>Mark unread</button>
              <button type="button" className="cdx-btn s g" onClick={() => dismissWithUndo(api, model, [entry.id], sessionId)}>Dismiss</button>
            </div>
          </div>
        ) : null}
      </div>
    </li>
  )
}

export function InboxSection({ sessionId, view, api, model, openSession, openFile }) {
  const hidden = useSignal(hiddenInbox)
  // unread first, then newest first (the view is newest first already)
  const entries = (view.inbox || []).filter((e) => !hidden.has(e.id)).map((e, i) => [e, i]).sort((a, b) => (a[0].read === b[0].read ? a[1] - b[1] : a[0].read ? 1 : -1)).map((x) => x[0])
  const [open, setOpen] = useState(null)
  const [focusId, setFocusId] = useState(null)
  const refs = useRef(new Map())
  const [posting, setPosting] = useState(false)
  const focused = focusId && entries.some((e) => e.id === focusId) ? focusId : (entries[0] && entries[0].id)

  const toggle = (entry, force) => {
    const willOpen = force === undefined ? open !== entry.id : force
    setOpen(willOpen ? entry.id : null)
    setFocusId(entry.id)
    if (willOpen && !entry.read) {
      // opening a row marks it read; scrolling it into view does not
      model.patch((v) => ({ ...v, unread: Math.max(0, (v.unread || 0) - 1), inbox: v.inbox.map((x) => (x.id === entry.id ? { ...x, read: true } : x)) }))
      api.inbox('read', [entry.id]).catch(() => {}).finally(() => model.refresh().catch(() => {}))
    }
  }
  const move = (delta) => {
    const i = entries.findIndex((e) => e.id === focused)
    const next = entries[Math.max(0, Math.min(entries.length - 1, i + delta))]
    if (next) { setFocusId(next.id); const el = refs.current.get(next.id); if (el) el.focus() }
  }
  const onKeyDown = (e) => {
    if (e.target.closest && e.target.closest('input,textarea,select')) return
    const entry = entries.find((x) => x.id === focused)
    if (!entry) return
    if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'J') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp' || e.key === 'k' || e.key === 'K') { e.preventDefault(); move(-1) }
    else if (e.key === 'Home') { e.preventDefault(); move(-1e6) }
    else if (e.key === 'End') { e.preventDefault(); move(1e6) }
    else if (e.key === 'Enter') { e.preventDefault(); toggle(entry) }
    else if ((e.key === 'e' || e.key === 'E') && !e.shiftKey) { e.preventDefault(); move(1); dismissWithUndo(api, model, [entry.id], sessionId) }
    else if (e.key === 'I' && e.shiftKey) { e.preventDefault(); markAllRead(api, model, view, sessionId) }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(null) }
  }
  const readIds = entries.filter((e) => e.read).map((e) => e.id)

  const unread = entries.filter((e) => !e.read).length
  return (
    <div onKeyDown={onKeyDown}>
      {entries.length ? (
        <div className="cdx-phead">
          <span className="cdx-help">{unread ? unread + ' unread' : 'All read'}</span>
          <span className="cdx-spacer" />
          {unread ? <button type="button" className="cdx-link" data-mark-all-read onClick={() => markAllRead(api, model, view, sessionId)}>Mark all read</button> : null}
        </div>
      ) : null}
      {entries.length === 0 ? (
        <Empty title="Inbox is empty">Messages from other chats and scripts that did not wake the agent will appear here.</Empty>
      ) : (
        <ul className="cdx-list plain" aria-label="Inbox messages">
          {entries.map((entry) => (
            <InboxRow key={entry.id} entry={entry} open={open === entry.id} focused={entry.id === focused}
              rowRef={(el) => { if (el) refs.current.set(entry.id, el); else refs.current.delete(entry.id) }}
              onFocusRow={() => setFocusId(entry.id)} onToggle={(force) => toggle(entry, force)}
              api={api} model={model} sessionId={sessionId} openSession={openSession} openFile={openFile} />
          ))}
        </ul>
      )}
      <div className="cdx-panelfoot">
        <button type="button" className="cdx-btn s g" aria-expanded={posting} data-post-toggle onClick={() => setPosting(!posting)}>{Icon.send(13)}Post to another chat</button>
        <span className="cdx-spacer" />
        {readIds.length ? <button type="button" className="cdx-btn s g" onClick={() => dismissWithUndo(api, model, readIds, sessionId)}>Clear read</button> : null}
      </div>
      {posting ? <PostForm sessionId={sessionId} onDone={() => setPosting(false)} /> : null}
    </div>
  )
}

/** Silent message into another chat: it lands in that chat's inbox without waking it. */
export function PostForm({ sessionId, onDone, initialTarget }) {
  const status = useSignal(statusModel)
  const [to, setTo] = useState(initialTarget || '')
  const [text, setText] = useState('')
  const [kind, setKind] = useState('note')
  const [visible, setVisible] = useState('user+model')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { if (!status.data) refreshStatus() }, [])
  const rows = useMemo(() => ((status.data && status.data.agents && status.data.agents.rows) || []).filter((r) => r.sessionId !== sessionId), [status.data, sessionId])
  const target = rows.find((r) => r.sessionId === to)

  const submit = async (e) => {
    e.preventDefault()
    if (!to || !text.trim()) return
    setBusy(true)
    setError('')
    try {
      await postToChat({ to, text: text.trim(), kind, visible, fromSessionId: sessionId })
      toast({ message: 'Posted silently to ' + ((target && target.title) || shortId(to)) + '. It did not wake that chat.', sessionId })
      setText('')
      if (onDone) onDone()
    } catch (err) {
      setError(errorText(err))
    } finally { setBusy(false) }
  }

  return (
    <form className="cdx-form" onSubmit={submit} aria-label="Post a silent message to another chat" data-post-form>
      <label className="cdx-field"><span>To</span>
        <select className="cdx-in" style={{ width: '100%' }} value={to} onChange={(e) => setTo(e.target.value)} required>
          <option value="">{rows.length ? 'Choose a chat' : 'Loading chats\u2026'}</option>
          {rows.map((r) => <option key={r.sessionId} value={r.sessionId}>{(r.title || '(untitled)') + (r.running ? ' (working)' : '') + ' \u00b7 ' + shortId(r.sessionId)}</option>)}
        </select>
      </label>
      <label className="cdx-field"><span>Message</span>
        <textarea className="cdx-in" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="What the other chat should know"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e) }} required />
      </label>
      <div className="cdx-frow">
        <div className="cdx-radio" role="radiogroup" aria-label="Who sees it">
          <label><input type="radio" name={'cdx-vis-' + sessionId} checked={visible === 'user+model'} onChange={() => setVisible('user+model')} />
            <span>The chat and its model<span className="cdx-help" style={{ display: 'block' }}>The model reads it on its next turn; the chat is not woken.</span></span></label>
          <label><input type="radio" name={'cdx-vis-' + sessionId} checked={visible === 'user'} onChange={() => setVisible('user')} />
            <span>Only the person reading that chat</span></label>
        </div>
        <label className="cdx-field" style={{ flex: '0 0 auto' }}><span>Kind</span>
          <select className="cdx-in" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="note">Note</option><option value="report">Report</option><option value="alert">Alert</option>
          </select>
        </label>
      </div>
      {error ? <Note tone="bad" role="alert">{error}</Note> : null}
      <div className="cdx-btnrow">
        <button type="submit" className="cdx-btn p s" disabled={busy || !to || !text.trim()}>{busy ? 'Posting\u2026' : 'Post silently'}</button>
        {onDone ? <button type="button" className="cdx-btn s g" onClick={onDone}>Cancel</button> : null}
      </div>
    </form>
  )
}
