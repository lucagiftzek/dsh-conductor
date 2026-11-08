/**
 * History sub-tab: ONE timeline, newest first, merging the resets (epochs:
 * tokens before and after, View handoff, View archive), the edited messages
 * (versions, with a word diff and Restore on expand) and the activity log.
 * /new and /clear have no Undo: the old history stays in the chat and in the
 * archive these rows open.
 */
import React, { useMemo, useState } from 'react'
import { fmtTokens, fmtWhen, fmtHM, epochLabel, byLabel, excerpt, wordDiff, tokenDelta, plural, toMs } from '../format.js'
import { Empty, copyText } from '../ui.jsx'
import { toast, toastError } from '../toasts.jsx'
import { useEditFallback, FALLBACK_NOTICE } from '../chat.jsx'
import { CheckpointsBlock, RecallBox } from './checkpoints.jsx'

export function DiffView({ before, after }) {
  const parts = useMemo(() => wordDiff(before, after), [before, after])
  return (
    <div className="cdx-diff" data-diff>
      {parts.map((p, i) => (p.type === 'add' ? <ins key={i}>{p.text}</ins> : p.type === 'del' ? <del key={i}>{p.text}</del> : <span key={i}>{p.text}</span>))}
    </div>
  )
}

function authorLabel(author) {
  if (author === 'original') return 'original'
  if (author === 'model' || author === 'the assistant') return 'by the assistant'
  return 'by you'
}

/** The expanded body of an edited message: version list, diff against the previous version, Restore. */
function VersionBody({ entry, api, model, sessionId }) {
  const versions = entry.versions || []
  const current = entry.current || (versions.length ? versions[versions.length - 1].v : 1)
  const [chosen, setChosen] = useState(current)
  const [busy, setBusy] = useState(false)
  const pick = versions.find((v) => v.v === chosen) || versions[versions.length - 1]
  const prev = pick ? versions.find((v) => v.v === pick.v - 1) : null
  if (!pick) return null
  const restore = async () => {
    setBusy(true)
    try {
      const r = await api.restore(entry.messageId, pick.v)
      toast({ message: 'Restored version ' + pick.v + ' as version ' + r.version + '. Nothing was deleted.', sessionId })
    } catch (e) {
      toastError('Could not restore that version.', e, sessionId)
    } finally {
      setBusy(false)
      model.refresh().catch(() => {})
    }
  }
  const delta = prev ? tokenDelta(prev.text, pick.text) : 0
  return (
    <div className="cdx-detail" style={{ gridColumn: '1 / -1' }} onClick={(e) => e.stopPropagation()}>
      <div className="cdx-vlist" role="group" aria-label="Versions">
        {[...versions].reverse().map((v) => (
          <button key={v.v} type="button" className="cdx-vrow" aria-pressed={v.v === pick.v} onClick={() => setChosen(v.v)}>
            <span className="cdx-num" style={{ width: 24 }}>{'v' + v.v}</span>
            <span className="cdx-grow cdx-ell">{authorLabel(v.author) + (v.reason ? ': ' + v.reason : '')}</span>
            {v.v === current ? <span className="cdx-chip clay">current</span> : null}
            <span className="cdx-help">{fmtWhen(v.at)}</span>
          </button>
        ))}
      </div>
      {prev ? (
        <>
          <div className="cdx-help">{'v' + prev.v + ' to v' + pick.v + ' \u00b7 ' + (delta >= 0 ? '+' : '') + delta + ' tokens'}</div>
          <DiffView before={prev.text} after={pick.text} />
        </>
      ) : <div className="cdx-diff">{pick.text}</div>}
      <div className="cdx-btnrow">
        {pick.v !== current ? <button type="button" className="cdx-btn s" disabled={busy} onClick={restore}>{'Restore version ' + pick.v}</button> : null}
        <button type="button" className="cdx-btn s g" onClick={async () => { const ok = await copyText(pick.text); toast({ message: ok ? 'Copied version ' + pick.v + '.' : 'Copy is not available in this browser.', sessionId }) }}>Copy</button>
      </div>
    </div>
  )
}

/** Timeline events from the view: resets, edits, then the remaining activity. */
export function historyEvents(view) {
  const out = []
  const epochs = view.epochs || []
  epochs.forEach((e, i) => out.push({ type: 'reset', at: e.at, key: 'ep:' + e.id, epoch: e, n: epochs.length - i }))
  for (const entry of view.versions || []) {
    const versions = entry.versions || []
    if (versions.length < 2) continue
    const last = versions[versions.length - 1]
    out.push({ type: 'edit', at: last.at, key: 'v:' + entry.messageId, entry })
  }
  for (const [i, a] of (view.activity || []).entries()) {
    if (a.kind === 'reset' || a.kind === 'edit' || a.kind === 'rewind') continue // shown by the rows above
    out.push({ type: a.kind === 'error' ? 'error' : 'other', at: a.at, key: 'a:' + i + ':' + a.at, activity: a })
  }
  return out.sort((a, b) => (toMs(b.at) || 0) - (toMs(a.at) || 0))
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'reset', label: 'Resets' },
  { id: 'edit', label: 'Edits' },
  { id: 'other', label: 'Other' },
]

function RewindRow({ ev, api, model, sessionId, latest }) {
  const e = ev.epoch
  const undo = async () => {
    try { const u = await api.rewindUndo(); toast({ message: u.text || 'Files put back.', sessionId }) } catch (err) { toastError('Could not undo the file restore.', err, sessionId) } finally { model.refresh().catch(() => {}) }
  }
  return (
    <>
      <div className="cdx-title"><span>{'Rewind' + (e.branch ? ' to a new chat' : '')}</span></div>
      <div className="cdx-meta"><span>{[e.files ? e.files + ' ' + plural(e.files, 'file') + ' restored' : '', byLabel(e.by)].filter(Boolean).join(' \u00b7 ')}</span></div>
      {latest && e.files ? <div className="cdx-btnrow" style={{ marginTop: 2 }}><button type="button" className="cdx-link" data-timeline-undo onClick={undo}>Undo file restore</button></div> : null}
    </>
  )
}

function ResetRow({ ev, openFile }) {
  const e = ev.epoch
  const before = e.tokensBefore
  const after = e.tokensAfter
  const known = Number.isFinite(before) && Number.isFinite(after)
  return (
    <>
      <div className="cdx-title"><span>{epochLabel(e.kind) + ' \u00b7 epoch ' + ev.n}</span></div>
      <div className="cdx-meta"><span>
        {(Number.isFinite(before) ? fmtTokens(before) : '?') + ' to ' + (Number.isFinite(after) ? fmtTokens(after) : 'measuring') + ' tokens'
          + (known && before > after ? ' \u00b7 saved ' + fmtTokens(before - after) : '') + ' \u00b7 ' + byLabel(e.by)}
      </span></div>
      {e.handoff || e.archive ? (
        <div className="cdx-btnrow" style={{ gap: 14, marginTop: 2 }}>
          {e.handoff ? <button type="button" className="cdx-link" onClick={() => openFile(e.handoff)} title={e.handoff}>View handoff</button> : null}
          {e.archive ? <button type="button" className="cdx-link" onClick={() => openFile(e.archive)} title={e.archive}>View archive</button> : null}
        </div>
      ) : null}
    </>
  )
}

export function HistoryPanel({ sessionId, view, api, model, openFile, openSession, putDraft }) {
  const [filter, setFilter] = useState('all')
  const [open, setOpen] = useState(null)
  const [limit, setLimit] = useState(60)
  const all = useMemo(() => historyEvents(view), [view.epochs, view.versions, view.activity])
  const counts = useMemo(() => ({ reset: all.filter((e) => e.type === 'reset').length, edit: all.filter((e) => e.type === 'edit').length }), [all])
  const fallback = useEditFallback(view)
  const shown = all.filter((e) => filter === 'all' || e.type === filter || (filter === 'other' && e.type === 'error')).slice(0, limit)
  const latestRewind = all.find((e) => e.type === 'reset' && e.epoch.kind === 'rewind')
  const top = (
    <>
      <CheckpointsBlock sessionId={sessionId} view={view} api={api} model={model} openSession={openSession} putDraft={putDraft} />
      <RecallBox sessionId={sessionId} api={api} openFile={openFile} />
    </>
  )
  if (!all.length) return <div>{top}<Empty title="Nothing yet">Resets, edited messages, drops and pins appear here, newest first.</Empty></div>
  return (
    <div>
      {top}
      {fallback ? <div className="cdx-fallback" role="note" data-edit-fallback title={'Reason: ' + fallback}>{FALLBACK_NOTICE}</div> : null}
      <div className="cdx-phead" style={{ paddingBottom: 0 }}><span className="cdx-help">Timeline</span></div>
      {counts.reset + counts.edit > 0 ? (
        <div className="cdx-phead" role="group" aria-label="Filter history">
          {FILTERS.map((f) => <button key={f.id} type="button" className="cdx-chipbtn" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
      ) : null}
      {!shown.length ? <Empty title="Nothing of this kind" /> : null}
      <ul className="cdx-list plain cdx-timeline" aria-label="History">
        {shown.map((ev) => {
          const isOpen = open === ev.key
          const expandable = ev.type === 'edit'
          return (
            <li key={ev.key}>
              <div className={'cdx-row' + (expandable ? ' click' : '') + (isOpen ? ' open' : '')} data-history={ev.type}
                tabIndex={expandable ? 0 : undefined} aria-expanded={expandable ? isOpen : undefined}
                onClick={expandable ? () => setOpen(isOpen ? null : ev.key) : undefined}
                onKeyDown={expandable ? (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(isOpen ? null : ev.key) } } : undefined}
                style={{ gridTemplateColumns: '40px minmax(0,1fr)', alignItems: 'start' }}>
                <span className="cdx-num cdx-when" title={fmtWhen(ev.at)}>{fmtHM(ev.at)}</span>
                <div className="cdx-main">
                  {ev.type === 'reset' && ev.epoch.kind === 'rewind' ? <RewindRow ev={ev} api={api} model={model} sessionId={sessionId} latest={ev === latestRewind} /> : null}
                  {ev.type === 'reset' && ev.epoch.kind !== 'rewind' ? <ResetRow ev={ev} openFile={openFile} /> : null}
                  {ev.type === 'edit' ? (
                    <>
                      <div className="cdx-title"><span>{(ev.entry.role === 'user' ? 'Edited your message' : 'Edited an answer') + ' \u00b7 v' + (ev.entry.current || ev.entry.versions.length)}</span></div>
                      <div className="cdx-meta"><span>{excerpt(ev.entry.versions[ev.entry.versions.length - 1].text, 90) + ' \u00b7 ' + ev.entry.versions.length + ' ' + plural(ev.entry.versions.length, 'version')}</span></div>
                      {fallback ? <div className="cdx-meta warn" data-edit-fallback-row><span>The chat shows the original text; the model sees this version.</span></div> : null}
                    </>
                  ) : null}
                  {ev.type === 'other' || ev.type === 'error' ? (
                    <div className={'cdx-line' + (ev.type === 'error' ? ' bad' : '')}>{ev.activity.text}{ev.activity.by && ev.activity.by !== 'user' ? <span className="cdx-help">{' \u00b7 ' + byLabel(ev.activity.by)}</span> : null}</div>
                  ) : null}
                </div>
                {isOpen ? <VersionBody entry={ev.entry} api={api} model={model} sessionId={sessionId} /> : null}
              </div>
            </li>
          )
        })}
      </ul>
      {shown.length >= limit ? <div className="cdx-more"><button type="button" className="cdx-btn s g" onClick={() => setLimit(limit + 100)}>Load older</button></div> : null}
    </div>
  )
}
