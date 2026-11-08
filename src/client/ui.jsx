/**
 * Shared UI primitives: icons, empty and error states, small hooks over
 * the module stores.
 */
import React, { useEffect, useState, useSyncExternalStore } from 'react'

// ── hooks ──────────────────────────────────────────────────────────────

/** Read a store signal ({ subscribe, get } or { subscribe, getSnapshot }). */
export function useSignal(signal) {
  const get = signal.getSnapshot || signal.get
  return useSyncExternalStore(signal.subscribe, get, get)
}

/** A clock that ticks every `ms` while `active` (for live durations). */
export function useNow(ms = 1000, active = true) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms, active])
  return now
}

export function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(String(text)).then(() => true, () => false)
  } catch { /* fall through */ }
  return Promise.resolve(false)
}

// ── icons (decorative; buttons carry aria-label) ───────────────────────

const svg = (size, children, extra) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"
    strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true" focusable="false" {...extra}>{children}</svg>
)

export const Icon = {
  conductor: (size = 16) => svg(size, <>
    <path d="M2.5 3.5h11" /><path d="M2.5 8h7.5" /><path d="M2.5 12.5h4.5" />
    <path d="M12.5 8v4.5" /><path d="M10.25 10.25h4.5" />
  </>),
  chevron: (size = 12) => svg(size, <path d="M6 3.5 10.5 8 6 12.5" />),
  star: (size = 15, filled = false) => svg(size, <path d="M8 1.9l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.3l-3.7 2.1.8-4.2L2 6.3l4.2-.5z" fill={filled ? 'currentColor' : 'none'} strokeLinejoin="round" />),
  pin: (size = 14) => svg(size, <><path d="M6 2.5h4l-.6 4 2.1 2.1v1H4.5v-1l2.1-2.1z" strokeLinejoin="round" /><path d="M8 9.6V14" /></>),
  copy: (size = 14) => svg(size, <><rect x="5.5" y="5.5" width="8" height="8" /><path d="M10.5 5.5v-3h-8v8h3" /></>),
  close: (size = 12) => svg(size, <><path d="M3.5 3.5l9 9" /><path d="M12.5 3.5l-9 9" /></>),
  refresh: (size = 14) => svg(size, <><path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.5v3h-3" /></>),
  open: (size = 14) => svg(size, <><path d="M9 2.5h4.5V7" /><path d="M13.5 2.5 7.5 8.5" /><path d="M11.5 9.5v4h-9v-9h4" /></>),
  undo: (size = 14) => svg(size, <><path d="M5.5 3 2.5 6l3 3" /><path d="M2.5 6h7a4 4 0 0 1 0 8H7" /></>),
  note: (size = 14) => svg(size, <><path d="M3 2.5h10v11H3z" /><path d="M5.5 6h5M5.5 9h5" /></>),
  mail: (size = 14) => svg(size, <><path d="M2 3.5h12v9H2z" /><path d="M2 3.5 8 9l6-5.5" /></>),
  plus: (size = 14) => svg(size, <><path d="M8 3v10" /><path d="M3 8h10" /></>),
  check: (size = 14) => svg(size, <path d="M3 8.5 6.5 12 13 4.5" />),
  inject: (size = 14) => svg(size, <><path d="M8 2.5v8" /><path d="M4.5 7 8 10.5 11.5 7" /><path d="M2.5 13.5h11" /></>),
  edit: (size = 14) => svg(size, <><path d="M10.5 2.5l3 3-8 8h-3v-3z" /></>),
  stop: (size = 14) => svg(size, <rect x="4" y="4" width="8" height="8" />),
  fork: (size = 14) => svg(size, <><path d="M4.5 2.5v4a3 3 0 0 0 3 3h1a3 3 0 0 1 3 3v1" /><path d="M11.5 2.5v4" /><path d="M4.5 9.5v4" /></>),
  more: (size = 16) => svg(size, <><rect x="2.5" y="7.25" width="1.5" height="1.5" fill="currentColor" stroke="none" /><rect x="7.25" y="7.25" width="1.5" height="1.5" fill="currentColor" stroke="none" /><rect x="12" y="7.25" width="1.5" height="1.5" fill="currentColor" stroke="none" /></>),
  send: (size = 14) => svg(size, <><path d="M2.5 8 13.5 2.5 10 13.5 7.5 8.5z" strokeLinejoin="round" /></>),
}

export function Empty({ title, children, action }) {
  return (
    <div className="cdx-empty">
      <b>{title}</b>
      {children}
      {action ? <div className="cdx-empty-act">{action}</div> : null}
    </div>
  )
}

export function Note({ tone, children, actions, role }) {
  return (
    <div className={'cdx-note' + (tone ? ' ' + tone : '')} role={role}>
      {children}
      {actions ? <div className="cdx-btnrow">{actions}</div> : null}
    </div>
  )
}

export function Skeleton({ rows = 3 }) {
  const list = []
  for (let i = 0; i < rows; i += 1) list.push(<div key={i} className="cdx-skel" aria-hidden="true" />)
  return <div aria-busy="true">{list}</div>
}

/** Section error with Retry and Copy details. */
export function SectionError({ what, error, onRetry }) {
  return (
    <Note tone="bad" role="alert" actions={<>
      {onRetry ? <button type="button" className="cdx-btn s" onClick={onRetry}>Retry</button> : null}
      <button type="button" className="cdx-btn s g" onClick={() => copyText(String((error && error.stack) || error))}>Copy details</button>
    </>}>
      {'Couldn\u2019t load ' + what + '. '}<span className="cdx-help">{String((error && error.message) || error || '')}</span>
    </Note>
  )
}

export function IconButton({ label, onClick, children, disabled, className, pressed, title }) {
  return (
    <button type="button" className={'cdx-ibtn' + (className ? ' ' + className : '')} aria-label={label} title={title || label}
      aria-disabled={disabled ? 'true' : undefined} aria-pressed={pressed === undefined ? undefined : pressed}
      onClick={(e) => { e.stopPropagation(); if (!disabled && onClick) onClick(e) }}>
      {children}
    </button>
  )
}

export function Switch({ checked, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" className="cdx-switch" aria-checked={Boolean(checked)} aria-label={label}
      disabled={disabled} onClick={() => onChange(!checked)} />
  )
}
