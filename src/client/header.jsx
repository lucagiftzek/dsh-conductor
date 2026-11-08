/**
 * The compact header of the Conductor tab: one line of numbers with a thin
 * single-colour bar (the category breakdown opens on demand), the primary
 * "New context" action with Clear and Compact in a menu, the live progress
 * card of a reset (elapsed time, Cancel; never a fake percentage) and the
 * result line with View handoff and View archive.
 */
import React, { useEffect, useRef, useState } from 'react'
import { fmtTokens, spokenTokens, meterModel, meterLevel, fmtClock, resetTitle, firstLine } from './format.js'
import { Icon, useNow } from './ui.jsx'
import { pref } from './store.js'
import { automationSummary, levelPhrase } from './sections/automation.jsx'

/** A reset the user cancelled is not a failure. */
export function isCancelled(last) {
  return Boolean(last && !last.ok && /cancel/i.test(String(last.text || '')))
}

export function Meter({ view, onFilter, onAutomation }) {
  const [open, setOpen] = useState(false)
  const m = meterModel(view && view.meter)
  const warnPercent = pref('warnPercent')
  const level = meterLevel(m.percent, warnPercent)
  const parts = m.segments.filter((s) => s.tokens > 0)
  const label = 'Context: ' + spokenTokens(m.total) + (m.window ? ' of ' + spokenTokens(m.window) + ' tokens used, ' + m.percent + ' percent.' : ' tokens.')
  const fill = m.window ? Math.max(0.5, Math.min(100, (m.total / m.window) * 100)) : 100
  return (
    <div className="cdx-meter">
      <button type="button" className="cdx-mline" aria-expanded={open} aria-controls="cdx-breakdown" data-meter-numbers
        title={open ? 'Hide the breakdown' : 'Show what fills the context'} onClick={() => setOpen(!open)}>
        <span className="cdx-num"><b>{fmtTokens(m.total)}</b>{m.window ? ' of ' + fmtTokens(m.window) : ' tokens'}</span>
        {m.percent !== null ? <span className={'cdx-pct ' + level}>{m.percent + '%'}</span> : null}
        <span className="cdx-chev" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>{Icon.chevron(10)}</span>
      </button>
      <div className={'cdx-thin ' + level} role="img" aria-label={label} data-meter-bar title={parts.map((s) => s.label + ' ' + fmtTokens(s.tokens)).join(', ')}>
        <i style={{ width: fill.toFixed(2) + '%' }} />
        {m.window && level !== 'ok' ? <span className="cdx-tick" style={{ left: warnPercent + '%' }} aria-hidden="true" /> : null}
        {view && view.level && view.level.percent && !view.level.paused ? (
          <span className="cdx-ltick" data-level-tick style={{ left: view.level.percent + '%' }} title={levelPhrase(view.level)} aria-hidden="true" />
        ) : null}
      </div>
      {automationSummary(view) ? (
        <button type="button" className="cdx-asum" data-automation-summary onClick={onAutomation} title="Open Automation">{automationSummary(view)}</button>
      ) : null}
      {open ? (
        <ul className="cdx-breakdown" id="cdx-breakdown" aria-label="Context by category">
          {parts.map((s) => (
            <li key={s.id}>
              <button type="button" className="cdx-brow" data-seg={s.id} title={'Show only ' + s.label.toLowerCase() + ' in Context'}
                onClick={() => { setOpen(false); onFilter(s.id) }}>
                <span className="cdx-sw" style={{ background: s.color }} aria-hidden="true" />
                <span className="cdx-grow">{s.label}</span>
                <span className="cdx-num">{fmtTokens(s.tokens)}</span>
              </button>
            </li>
          ))}
          {m.free !== null ? <li><span className="cdx-brow muted"><span className="cdx-sw" aria-hidden="true" /><span className="cdx-grow">Free</span><span className="cdx-num">{fmtTokens(m.free)}</span></span></li> : null}
        </ul>
      ) : null}
      {level === 'bad' ? <div className="cdx-hint" role="note">{'Context is ' + m.percent + '% full. Start a new context to continue with a handoff.'}</div> : null}
    </div>
  )
}

/** The "..." menu: Clear, Compact, Refresh. Arrow keys move, Escape closes. */
function MoreMenu({ items, disabledTitle }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const btn = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const first = ref.current && ref.current.querySelector('[role=menuitem]:not([aria-disabled=true])')
    if (first) first.focus()
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target) && btn.current && !btn.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const onKey = (e) => {
    const all = ref.current ? [...ref.current.querySelectorAll('[role=menuitem]')] : []
    const i = all.indexOf(document.activeElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); if (btn.current) btn.current.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); const n = all[(i + 1) % all.length]; if (n) n.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); const n = all[(i - 1 + all.length) % all.length]; if (n) n.focus() }
  }
  return (
    <span className="cdx-menuwrap">
      <button type="button" ref={btn} className="cdx-ibtn" aria-label="More actions" title="More actions" aria-haspopup="menu" aria-expanded={open}
        data-more onClick={() => setOpen(!open)}>{Icon.more(16)}</button>
      {open ? (
        <span className="cdx-menu" role="menu" ref={ref} onKeyDown={onKey}>
          {items.map((it) => (
            <button key={it.id} type="button" role="menuitem" className={'cdx-mitem' + (it.danger ? ' d' : '')} data-menu={it.id}
              aria-disabled={it.disabled ? 'true' : undefined} title={it.disabled ? disabledTitle : it.title}
              onClick={() => { if (it.disabled) return; setOpen(false); it.run() }}>
              <span>{it.label}</span>{it.hint ? <span className="cdx-mhint">{it.hint}</span> : null}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  )
}

/**
 * Actions, live progress and the result of the last reset.
 * @param props.reset { kind, at } while a reset started here is in flight
 */
export function ResetBar({ view, fetchedAt, reset, onReset, onCancel, cancelling, onRefresh, refreshing, onDismissResult, resultDismissed, openFile, onSetup, onAutomation }) {
  const [confirm, setConfirm] = useState(false)
  const progress = view && view.progress
  const running = Boolean(progress) || Boolean(reset)
  const now = useNow(1000, running)
  const engineOff = view && view.engine === 'unavailable'
  const agentBusy = view && view.status === 'running'
  const blocked = engineOff ? 'The compaction hook is not installed, so resets are unavailable (see the server log).'
    : agentBusy ? 'The agent is working. Try again when it finishes.' : ''

  if (running) {
    const kind = (progress && progress.kind) || (reset && reset.kind) || 'new'
    let elapsed = 0
    if (progress) elapsed = (progress.elapsedMs || 0) + Math.max(0, now - (fetchedAt || now))
    else if (reset) elapsed = now - reset.at
    return (
      <div className="cdx-progress" role="status" aria-live="polite" data-reset-progress>
        <div className="cdx-ptitle">
          <span>{progress ? resetTitle(kind) + '\u2026' : 'Starting /' + kind + '\u2026'}</span>
          <span className="cdx-num" aria-hidden="true">{fmtClock(elapsed)}</span>
        </div>
        <div className="cdx-psub">
          {kind === 'new'
            ? (elapsed > 10000 ? 'This usually takes under 90 seconds. Your context is unchanged until it finishes.' : 'Your context is unchanged until the handoff is written.')
            : kind === 'clear' ? 'Archiving the context, then emptying it. Pins are kept.' : 'Your context is unchanged until the checkpoint is written.'}
        </div>
        {progress && onCancel ? (
          <div className="cdx-actions" style={{ marginTop: 8 }}>
            <button type="button" className="cdx-btn s" data-reset-cancel disabled={cancelling} onClick={onCancel}>{cancelling ? 'Cancelling\u2026' : 'Cancel'}</button>
          </div>
        ) : null}
        <div className="cdx-indet" aria-hidden="true" />
      </div>
    )
  }

  const last = view && view.lastReset
  const epoch = last && last.ok && view.epochs && view.epochs[0] && view.epochs[0].kind === last.kind ? view.epochs[0] : null
  const fresh = last && !resultDismissed && (Date.now() - Date.parse(last.at) < 30 * 60 * 1000)
  const cancelled = isCancelled(last)

  return (
    <>
      {confirm ? (
        <div className="cdx-confirm" role="group" aria-label="Confirm clear">
          <div><b>Clear the model context?</b> The chat stays visible and is archived. Pins are kept. There is no undo.</div>
          <div className="cdx-actions">
            <button type="button" className="cdx-btn s" autoFocus onClick={() => setConfirm(false)}>Keep context</button>
            <span className="cdx-spacer" />
            <button type="button" className="cdx-btn s d" data-confirm-clear onClick={() => { setConfirm(false); onReset('clear') }}>Clear context</button>
          </div>
        </div>
      ) : (
        <div className="cdx-actions">
          <button type="button" className="cdx-btn p" data-reset="new" disabled={Boolean(blocked) || !view}
            title={blocked || 'Start fresh from a handoff the assistant writes (/new). Pins are kept.'}
            onClick={() => onReset('new')}>New context</button>
          <span className="cdx-spacer" />
          {refreshing ? <span className="cdx-help" aria-live="polite">Refreshing</span> : null}
          <MoreMenu disabledTitle={blocked} items={[
            { id: 'clear', label: 'Clear context', hint: '/clear', disabled: Boolean(blocked) || !view, title: 'Empty the model context; the chat stays visible and archived.', run: () => setConfirm(true) },
            { id: 'force-compact', label: 'Compact', hint: '/force-compact', disabled: Boolean(blocked) || !view, title: 'Summarise the conversation into a checkpoint.', run: () => onReset('force-compact') },
            ...(onAutomation ? [{ id: 'automation', label: 'Automation', run: onAutomation }] : []),
            { id: 'refresh', label: 'Refresh', run: onRefresh },
            ...(onSetup ? [{ id: 'setup', label: 'Run setup guide again', run: onSetup }] : []),
          ]} />
        </div>
      )}
      {fresh ? (
        <div className={'cdx-result' + (last.ok ? '' : cancelled ? ' warn' : ' bad')} role={last.ok || cancelled ? 'status' : 'alert'} data-reset-result>
          <div className="cdx-grow">
            <div>{last.ok ? firstLine(last.text, 240) : (firstLine(last.text, 300) || 'The reset failed. Your context is unchanged.')}</div>
            {epoch && (epoch.handoff || epoch.archive) ? (
              <div className="cdx-links">
                {epoch.handoff ? <button type="button" className="cdx-link" onClick={() => openFile(epoch.handoff)}>View handoff</button> : null}
                {epoch.archive ? <button type="button" className="cdx-link" onClick={() => openFile(epoch.archive)}>View archive</button> : null}
              </div>
            ) : null}
          </div>
          <button type="button" className="cdx-ibtn" aria-label="Dismiss result" title="Dismiss" onClick={onDismissResult}>{Icon.close(12)}</button>
        </div>
      ) : null}
    </>
  )
}
