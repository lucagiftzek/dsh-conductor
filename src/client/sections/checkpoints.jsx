/**
 * Checkpoints, rewind and recall (top of the History sub-tab).
 *
 * A checkpoint is set before every prompt (dimmed when the turn was not
 * started by the user) and by hand ("Set checkpoint", optionally named).
 * Rewind opens an inline panel: what will happen (the file preview with its
 * conflicts), Chat and files / Chat only / Files only, Continue in a new chat,
 * and Overwrite only when there are conflicts. The chat part cannot be undone
 * (it is archived); restored files can ("Undo file restore").
 * "Search earlier context" searches this chat's archives, drops and handoffs.
 */
import React, { useEffect, useState } from 'react'
import { fmtWhen, fmtAgo, excerpt, plural } from '../format.js'
import { Note, copyText } from '../ui.jsx'
import { toast, toastError } from '../toasts.jsx'
import { errorText } from '../api.js'

const SCOPES = [
  { id: 'both', label: 'Chat and files', chat: true, files: true },
  { id: 'chat', label: 'Chat only', chat: true, files: false },
  { id: 'files', label: 'Files only', chat: false, files: true },
]

export function checkpointTitle(cp) {
  return cp.name || cp.label || (cp.kind === 'manual' ? 'Checkpoint' : 'Prompt')
}

function fileLine(f) {
  if (f.action === 'keep') return 'kept (' + (f.skipped || 'not restorable') + ')'
  return f.action === 'delete' ? 'deleted (the agent created it)' : 'restored'
}

/** What a rewind changes, in one line. */
export function planSummary(files) {
  const list = Array.isArray(files) ? files : []
  const restore = list.filter((f) => f.action === 'restore' && !f.conflict).length
  const del = list.filter((f) => f.action === 'delete' && !f.conflict).length
  const conflicts = list.filter((f) => f.conflict).length
  if (!list.length) return 'No file the agent edited changed since then.'
  const parts = []
  if (restore) parts.push(restore + ' ' + plural(restore, 'file') + ' restored')
  if (del) parts.push(del + ' ' + plural(del, 'file') + ' deleted')
  let s = parts.join(', ') || 'Nothing to restore'
  if (conflicts) s += '; ' + conflicts + ' changed outside the agent (kept unless you overwrite)'
  return s + '.'
}

function RewindPanel({ cp, api, model, sessionId, openSession, putDraft, onClose, busyAgent }) {
  const [plan, setPlan] = useState(null)
  const [planError, setPlanError] = useState(null)
  const [scope, setScope] = useState('both')
  const [branch, setBranch] = useState(false)
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  useEffect(() => {
    let alive = true
    api.checkpoints(cp.id).then((r) => { if (alive) setPlan((r.preview && r.preview.files) || []) }, (e) => { if (alive) setPlanError(e) })
    return () => { alive = false }
  }, [cp.id])
  const s = SCOPES.find((x) => x.id === scope)
  const conflicts = (plan || []).filter((f) => f.conflict)

  const run = async () => {
    setBusy(true)
    try {
      const r = await api.rewind({ target: cp.id, chat: s.chat, files: s.files, branch, force: force && conflicts.length > 0 })
      setResult(r)
      const undoId = r.files && r.files.undoId
      toast({
        message: r.text || 'Rewound.',
        sessionId,
        undoLabel: 'Undo file restore',
        undo: undoId ? async () => { const u = await api.rewindUndo(); model.refresh().catch(() => {}); return u.text || 'Files put back.' } : null,
      })
    } catch (e) {
      toastError('Could not rewind.', e, sessionId)
    } finally {
      setBusy(false)
      model.refresh().catch(() => {})
    }
  }

  if (result) {
    const prompt = result.prompt
    return (
      <div className="cdx-rewind" role="group" aria-label="Rewind result" data-rewind-result onClick={(e) => e.stopPropagation()}>
        <div className="cdx-text">{result.text}</div>
        <div className="cdx-btnrow">
          {result.newChat ? <button type="button" className="cdx-btn s p" data-open-branch onClick={() => openSession(result.newChat)}>Open the new chat</button> : null}
          {prompt && putDraft ? <button type="button" className="cdx-btn s" data-put-prompt onClick={() => { const ok = putDraft(sessionId, prompt); toast({ message: ok ? 'The prompt is back in the input box.' : 'Could not reach the input box; the prompt was copied instead.', sessionId }); if (!ok) copyText(prompt) }}>Put the prompt back in the input box</button> : null}
          {prompt && !putDraft ? <button type="button" className="cdx-btn s" data-copy-prompt onClick={async () => { const ok = await copyText(prompt); toast({ message: ok ? 'Prompt copied.' : 'Copy is not available in this browser.', sessionId }) }}>Copy the prompt</button> : null}
          {result.files && result.files.undoId ? <button type="button" className="cdx-btn s g" data-undo-files onClick={async () => {
            try { const u = await api.rewindUndo(); toast({ message: u.text || 'Files put back.', sessionId }) } catch (e) { toastError('Could not undo the file restore.', e, sessionId) } finally { model.refresh().catch(() => {}) }
          }}>Undo file restore</button> : null}
          <span className="cdx-spacer" />
          <button type="button" className="cdx-btn s g" onClick={onClose}>Close</button>
        </div>
      </div>
    )
  }

  return (
    <div className="cdx-rewind" role="group" aria-label={'Rewind to before ' + checkpointTitle(cp)} data-rewind-panel onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="cdx-help">{'Back to the moment before "' + excerpt(checkpointTitle(cp), 60) + '"'}</div>
      <div className="cdx-radio" role="radiogroup" aria-label="What to rewind">
        {SCOPES.map((x) => (
          <label key={x.id}><input type="radio" name={'cdx-scope-' + cp.id} checked={scope === x.id} onChange={() => setScope(x.id)} />{x.label}</label>
        ))}
      </div>
      {s.chat ? <div className="cdx-help">Chat: everything after this point leaves the model context. It stays visible above and is archived; this part has no undo.</div> : null}
      {s.files ? (
        <div className="cdx-plan" data-file-plan>
          {planError ? <span className="cdx-help">{'Could not load the file preview: ' + errorText(planError)}</span>
            : plan === null ? <span className="cdx-help">Checking files\u2026</span>
              : (
                <>
                  <div className="cdx-help">{'Files: ' + planSummary(plan)}</div>
                  {plan.length ? (
                    <ul className="cdx-flist">
                      {plan.slice(0, 12).map((f) => (
                        <li key={f.path} className={f.conflict ? 'conflict' : ''}>
                          <span className="cdx-ell cdx-lell" title={f.path}>{'\u200e' + f.path + '\u200e'}</span>
                          <span className="cdx-help">{f.conflict ? 'changed outside the agent' : fileLine(f)}</span>
                        </li>
                      ))}
                      {plan.length > 12 ? <li className="cdx-help">{'and ' + (plan.length - 12) + ' more'}</li> : null}
                    </ul>
                  ) : null}
                  <div className="cdx-help">Changes made by shell commands are not tracked.</div>
                </>
              )}
        </div>
      ) : null}
      <label className="cdx-check2"><input type="checkbox" checked={branch} onChange={(e) => setBranch(e.target.checked)} />Continue in a new chat (this chat stays as it is)</label>
      {s.files && conflicts.length ? (
        <label className="cdx-check2 warn"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />{'Overwrite ' + conflicts.length + ' ' + plural(conflicts.length, 'file') + ' changed outside the agent'}</label>
      ) : null}
      <div className="cdx-btnrow">
        <button type="button" className="cdx-btn s d" data-rewind-confirm disabled={busy || busyAgent} title={busyAgent ? 'The agent is working. Rewind when it has finished.' : undefined} onClick={run}>{busy ? 'Rewinding\u2026' : branch ? 'Create the new chat' : 'Rewind'}</button>
        <button type="button" className="cdx-btn s g" onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

export function CheckpointsBlock({ sessionId, view, api, model, openSession, putDraft }) {
  const cps = view.checkpoints || []
  const [open, setOpen] = useState(null)
  const [naming, setNaming] = useState(null) // string while the name field is open
  const [showAll, setShowAll] = useState(false)
  const busyAgent = view.status === 'running'
  const save = async () => {
    try {
      const r = await api.checkpoint((naming || '').trim() || undefined)
      toast({ message: r.text || 'Checkpoint set.', sessionId })
      setNaming(null)
    } catch (e) { toastError('Could not set a checkpoint.', e, sessionId) } finally { model.refresh().catch(() => {}) }
  }
  const shown = showAll ? cps : cps.slice(0, 6)
  return (
    <div className="cdx-cps" data-checkpoints>
      <div className="cdx-phead">
        <span className="cdx-help">Checkpoints</span>
        <span className="cdx-spacer" />
        {naming === null ? <button type="button" className="cdx-link" data-set-checkpoint onClick={() => setNaming('')}>Set checkpoint</button> : null}
      </div>
      {naming !== null ? (
        <div className="cdx-btnrow" style={{ padding: '0 14px 8px' }}>
          <input className="cdx-in s" style={{ flex: '1 1 120px', width: 'auto' }} placeholder="Name (optional)" aria-label="Checkpoint name" value={naming} autoFocus
            onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); setNaming(null) } }} />
          <button type="button" className="cdx-btn s p" data-save-checkpoint onClick={save}>Set</button>
          <button type="button" className="cdx-btn s g" onClick={() => setNaming(null)}>Cancel</button>
        </div>
      ) : null}
      {!cps.length ? <div className="cdx-empty" style={{ paddingTop: 2 }}>A checkpoint is set before every prompt. Rewind brings the chat and the agent's file edits back to one.</div> : (
        <ul className="cdx-list plain" aria-label="Checkpoints">
          {shown.map((cp) => {
            const isOpen = open === cp.id
            const auto = cp.kind === 'turn' && cp.auto
            return (
              <li key={cp.id}>
                <div className={'cdx-row cdx-cp' + (auto ? ' auto' : '') + (isOpen ? ' open' : '')} data-checkpoint={cp.id} style={{ gridTemplateColumns: '40px minmax(0,1fr) auto', alignItems: 'start' }}>
                  <span className="cdx-num cdx-when" title={fmtWhen(cp.at)}>{fmtWhen(cp.at).replace(/^today /, '')}</span>
                  <div className="cdx-main">
                    <div className="cdx-title">
                      {cp.kind === 'manual' ? <span className="cdx-chip clay">checkpoint</span> : null}
                      <span title={checkpointTitle(cp)}>{excerpt(checkpointTitle(cp), 80)}</span>
                    </div>
                    <div className="cdx-meta"><span>{[auto ? 'automatic turn' : cp.kind === 'manual' ? 'set by hand' : 'your prompt', cp.files ? cp.files + ' ' + plural(cp.files, 'file') + ' edited' : '', fmtAgo(cp.at)].filter(Boolean).join(' \u00b7 ')}</span></div>
                  </div>
                  <button type="button" className="cdx-btn s g" data-rewind={cp.id} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : cp.id)}>Rewind</button>
                  {isOpen ? <div style={{ gridColumn: '1 / -1' }}><RewindPanel cp={cp} api={api} model={model} sessionId={sessionId} openSession={openSession} putDraft={putDraft} busyAgent={busyAgent} onClose={() => setOpen(null)} /></div> : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {cps.length > 6 ? <div className="cdx-panelfoot" style={{ paddingTop: 2 }}><button type="button" className="cdx-link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Fewer' : 'All ' + cps.length + ' checkpoints'}</button></div> : null}
    </div>
  )
}

const KIND_LABEL = { archive: 'archive', dropped: 'dropped', handoff: 'handoff' }

export function RecallBox({ sessionId, api, openFile }) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  const [error, setError] = useState(null)
  const search = async (e) => {
    if (e) e.preventDefault()
    if (!q.trim()) return
    setBusy(true)
    setError(null)
    try { setRes(await api.recall(q.trim())) } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return (
    <div className="cdx-recall" data-recall>
      <form className="cdx-btnrow" style={{ padding: '6px 14px 8px' }} onSubmit={search} role="search">
        <input className="cdx-in s" type="search" style={{ flex: '1 1 140px', width: 'auto' }} placeholder="Search earlier context" aria-label="Search earlier context"
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && res) { e.stopPropagation(); setRes(null) } }} />
        <button type="submit" className="cdx-btn s" disabled={busy || !q.trim()}>{busy ? 'Searching\u2026' : 'Search'}</button>
      </form>
      {error ? <Note tone="bad" role="alert">{'Search failed: ' + errorText(error)}</Note> : null}
      {res ? (
        <div aria-live="polite">
          <div className="cdx-phead" style={{ paddingTop: 0 }}>
            <span className="cdx-help">{res.hits && res.hits.length ? res.hits.length + ' ' + plural(res.hits.length, 'result') + ' in ' + (res.searched || 0) + ' ' + plural(res.searched || 0, 'file') : (res.error || 'Nothing found in ' + (res.searched || 0) + ' ' + plural(res.searched || 0, 'file') + '.')}</span>
            <span className="cdx-spacer" />
            <button type="button" className="cdx-link" onClick={() => setRes(null)}>Clear</button>
          </div>
          <ul className="cdx-list plain" aria-label="Search results">
            {(res.hits || []).map((h, i) => (
              <li key={i} className="cdx-row" data-recall-hit style={{ gridTemplateColumns: 'minmax(0,1fr) auto', alignItems: 'start' }}>
                <div className="cdx-main">
                  <div className="cdx-meta"><span className="cdx-chip">{KIND_LABEL[h.kind] || h.kind}</span><span>{(h.when ? fmtWhen(h.when) + ' \u00b7 ' : '') + 'line ' + h.line}</span></div>
                  <div className="cdx-snippet">{String(h.snippet || '').slice(0, 400)}</div>
                </div>
                <button type="button" className="cdx-btn s g" onClick={() => openFile(h.path)} title={h.path}>Open</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
