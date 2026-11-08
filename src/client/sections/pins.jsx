/**
 * Pins section (UX spec A7): what stays in the model context across /new
 * and /clear, newest first, with its token cost, copy, note and unpin
 * (with Undo).
 */
import React, { useState } from 'react'
import { fmtTokens, fmtAgo, excerpt } from '../format.js'
import { Icon, IconButton, Empty, copyText } from '../ui.jsx'
import { toast, toastError } from '../toasts.jsx'

export const PIN_LIMIT = 50


/** Unpin with an Undo that pins the same message again (same note). */
export async function unpinWithUndo(api, model, pin, sessionId) {
  await api.unpin(pin.id)
  toast({
    message: 'Unpinned. ' + fmtTokens(pin.tokens || 0) + ' tokens leave the context at the next reset.',
    sessionId,
    undo: async () => {
      await api.pin(pin.messageId, pin.note)
      model.refresh().catch(() => {})
      return 'Pinned again. ' + fmtTokens(pin.tokens || 0) + ' tokens.'
    },
  })
  model.refresh().catch(() => {})
}

function PinRow({ pin, api, model, sessionId }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState(null)
  const [busy, setBusy] = useState(false)

  const saveNote = async () => {
    setBusy(true)
    try {
      await api.pinNote(pin.id, note.trim())
      toast({ message: note.trim() ? 'Note saved.' : 'Note removed.', sessionId })
      setNote(null)
    } catch (e) {
      toastError('Could not save the note.', e, sessionId)
    } finally {
      setBusy(false)
      model.refresh().catch(() => {})
    }
  }

  return (
    <li>
      <div className={'cdx-row click' + (open ? ' open' : '')} tabIndex={0} data-pin={pin.id} aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(!open) } }}>
        <span style={{ color: 'var(--clay)', display: 'inline-flex' }} aria-hidden="true">{Icon.pin(13)}</span>
        <div className="cdx-main">
          <div className="cdx-title"><span className="cdx-clamp" style={{ whiteSpace: 'normal' }}>{excerpt(pin.text, 140)}</span></div>
          <div className="cdx-meta">
            <span className="cdx-chip">{pin.role === 'user' ? 'You' : 'Assistant'}</span>
            <span>{(pin.by === 'model' ? 'pinned by the assistant' : 'pinned') + ' ' + fmtAgo(pin.at)}</span>
            {pin.note ? <span title={pin.note}>{'\u00b7 ' + pin.note}</span> : null}
          </div>
        </div>
        <div className="cdx-side">
          <span className="cdx-acts">
            <IconButton label="Copy pinned text" onClick={async () => { const ok = await copyText(pin.text); toast({ message: ok ? 'Copied the pinned text.' : 'Copy is not available in this browser.', sessionId }) }}>{Icon.copy(13)}</IconButton>
            <IconButton label="Edit note" onClick={() => { setOpen(true); setNote(pin.note || '') }}>{Icon.note(13)}</IconButton>
            <IconButton label="Unpin" onClick={() => unpinWithUndo(api, model, pin, sessionId).catch((e) => toastError('Could not unpin.', e, sessionId))}>{Icon.close(12)}</IconButton>
          </span>
          <span className="cdx-num" title="Tokens this pin adds to every context">{fmtTokens(pin.tokens || 0)}</span>
        </div>
        {open ? (
          <div className="cdx-detail" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {note !== null ? (
              <>
                <label className="cdx-field"><span>Note (shown with the pin, up to 300 characters)</span>
                  <input className="cdx-in" maxLength={300} value={note} autoFocus onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveNote(); if (e.key === 'Escape') setNote(null) }} />
                </label>
                <div className="cdx-btnrow">
                  <button type="button" className="cdx-btn p s" disabled={busy} onClick={saveNote}>Save note</button>
                  <button type="button" className="cdx-btn s g" onClick={() => setNote(null)}>Cancel</button>
                </div>
              </>
            ) : <div className="cdx-text">{pin.text}</div>}
          </div>
        ) : null}
      </div>
    </li>
  )
}

export function PinsSection({ sessionId, view, api, model }) {
  const pins = [...(view.pins || [])].reverse() // newest first
  if (!pins.length) {
    return <Empty title="No pinned messages">Click the star on a message, or type /pin, to keep it in context across /new and /clear.</Empty>
  }
  const full = pins.length >= PIN_LIMIT
  const tokens = pins.reduce((s, p) => s + (p.tokens || 0), 0)
  return (
    <div>
      <div className="cdx-phead">
        <span className="cdx-help" style={full ? { color: 'var(--warn)' } : undefined}>
          {full ? 'Pin limit reached. Unpin one to add another.' : pins.length + ' ' + (pins.length === 1 ? 'pin' : 'pins') + ', ' + fmtTokens(tokens) + ' tokens, kept across every reset'}
        </span>
      </div>
      <ul className="cdx-list plain" aria-label="Pinned messages">
        {pins.map((p) => <PinRow key={p.id} pin={p} api={api} model={model} sessionId={sessionId} />)}
      </ul>
    </div>
  )
}

