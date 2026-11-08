/**
 * One shared toast system (UX spec A13). Toasts live in a module store so
 * actions started in one component can still report after it unmounts;
 * the tab root renders them for its chat. Every toast is mirrored into a
 * local log that the Activity section shows, so nothing is lost when a toast
 * times out (WCAG 2.2 time limits).
 *
 *   undo toasts   undoSeconds (default 10 s), pause on hover and focus
 *   info toasts   4 s
 *   error toasts  never auto dismiss
 */
import React, { useEffect, useRef, useState } from 'react'
import { createSignal, pref } from './store.js'
import { Icon, useSignal } from './ui.jsx'
import { errorText } from './api.js'

export const toastStore = createSignal([])
/** Client-side log lines (toasts), newest first, capped. */
export const localLog = createSignal([])
/** The polite announcement for screen readers (the latest non-error toast). */
export const announcer = createSignal({ text: '', at: 0 })

let seq = 0
const timers = new Map() // id -> { timer, remaining, startedAt }
const MAX_VISIBLE = 3

const LIVE_ID = 'dsh-conductor-live'

/**
 * Polite announcement through one document-level live region, so the star
 * in the chat and the tab share it (and it exists before the tab mounts).
 */
export function announce(text) {
  const value = String(text || '')
  announcer.set({ text: value, at: Date.now() })
  if (typeof document === 'undefined' || !document.body) return
  let region = document.getElementById(LIVE_ID)
  if (!region) {
    region = document.createElement('div')
    region.id = LIVE_ID
    region.setAttribute('role', 'status')
    region.setAttribute('aria-live', 'polite')
    region.setAttribute('aria-atomic', 'true')
    region.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0'
    document.body.appendChild(region)
  }
  // clear first so repeating the same sentence is announced again
  region.textContent = ''
  setTimeout(() => { region.textContent = value }, 30)
}

function remove(id) {
  const t = timers.get(id)
  if (t && t.timer) clearTimeout(t.timer)
  timers.delete(id)
  toastStore.set(toastStore.get().filter((x) => x.id !== id))
}

function schedule(id, ms) {
  const entry = timers.get(id) || {}
  if (entry.timer) clearTimeout(entry.timer)
  entry.remaining = ms
  entry.startedAt = Date.now()
  entry.timer = setTimeout(() => remove(id), ms)
  timers.set(id, entry)
}

/**
 * Show a toast.
 * @param {object} spec
 * @param {string} spec.message one sentence with a number where possible
 * @param {'info'|'error'} [spec.tone]
 * @param {() => Promise<string|void>} [spec.undo] reverts the action; resolves to the copy shown afterwards
 * @param {string} [spec.sessionId] chat this toast belongs to
 * @param {number} [spec.ms] override the lifetime
 * @returns {number} toast id
 */
export function toast(spec) {
  seq += 1
  const id = seq
  const tone = spec.tone === 'error' ? 'error' : 'info'
  const ms = tone === 'error' ? 0 : (spec.ms || (spec.undo ? Math.max(5, Math.min(30, pref('undoSeconds'))) * 1000 : 4000))
  const entry = { id, message: String(spec.message || ''), tone, undo: spec.undo || null, undoLabel: spec.undoLabel || 'Undo', sessionId: spec.sessionId || null, ms, at: Date.now() }
  let list = [...toastStore.get(), entry]
  while (list.length > MAX_VISIBLE) {
    const oldest = list[0]
    const t = timers.get(oldest.id)
    if (t && t.timer) clearTimeout(t.timer)
    timers.delete(oldest.id)
    list = list.slice(1)
  }
  toastStore.set(list)
  if (ms > 0) schedule(id, ms)
  localLog.set([{ at: new Date().toISOString(), kind: tone === 'error' ? 'error' : 'ui', text: entry.message, sessionId: entry.sessionId }, ...localLog.get()].slice(0, 200))
  if (tone !== 'error') announce(entry.message)
  return id
}

export function toastError(message, error, sessionId) {
  return toast({ tone: 'error', message: message + (error ? ' ' + errorText(error) : ''), sessionId })
}

export function dismissToast(id) {
  remove(id)
}

/** Pause or resume every running timer (hover or focus within the stack). */
export function pauseToasts(paused) {
  for (const [id, entry] of timers) {
    if (paused && entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
      entry.remaining = Math.max(800, entry.remaining - (Date.now() - entry.startedAt))
    } else if (!paused && !entry.timer) {
      schedule(id, entry.remaining)
    }
  }
}

/** Run a toast's undo: the toast is replaced by the outcome. */
export async function runUndo(id) {
  const entry = toastStore.get().find((t) => t.id === id)
  if (!entry || !entry.undo) return
  remove(id)
  try {
    const text = await entry.undo()
    toast({ message: text || 'Undone.', sessionId: entry.sessionId })
  } catch (error) {
    toastError('Undo failed.', error, entry.sessionId)
  }
}

/** The newest undo toast of a chat, for Ctrl/Cmd+Z. */
export function latestUndo(sessionId) {
  const list = toastStore.get().filter((t) => t.undo && (!sessionId || !t.sessionId || t.sessionId === sessionId))
  return list.length ? list[list.length - 1] : null
}

export function resetToasts() {
  for (const entry of timers.values()) if (entry.timer) clearTimeout(entry.timer)
  timers.clear()
  toastStore.set([])
  localLog.set([])
  announcer.set({ text: '', at: 0 })
}

function ToastView({ t, paused }) {
  return (
    <div className={'cdx-toast' + (t.tone === 'error' ? ' bad' : '') + (paused ? ' paused' : '')}
      role={t.tone === 'error' ? 'alert' : 'status'} data-toast={t.id}>
      <span className="cdx-grow">{t.message}</span>
      {t.undo ? <button type="button" className="cdx-btn s" data-toast-undo onClick={() => runUndo(t.id)}>{t.undoLabel}</button> : null}
      <button type="button" className="cdx-ibtn" aria-label="Dismiss notification" title="Dismiss" onClick={() => dismissToast(t.id)}>{Icon.close(12)}</button>
      {t.ms > 0 ? <span className="cdx-toast-bar" aria-hidden="true" style={{ animationDuration: t.ms + 'ms' }} /> : null}
    </div>
  )
}

/** The toast stack of one chat (rendered inside the tab root). */
export function ToastHost({ sessionId }) {
  const all = useSignal(toastStore)
  const [paused, setPaused] = useState(false)
  const ref = useRef(null)
  const list = all.filter((t) => !t.sessionId || t.sessionId === sessionId)
  useEffect(() => { pauseToasts(paused) }, [paused])
  useEffect(() => () => pauseToasts(false), [])
  if (!list.length) return null
  return (
    <div className="cdx-toasts" ref={ref}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => { if (!ref.current || !ref.current.contains(e.relatedTarget)) setPaused(false) }}>
      {list.map((t) => <ToastView key={t.id} t={t} paused={paused} />)}
    </div>
  )
}

/** The assertive region of the tab root (errors also carry role=alert on their toast). */
export function LiveRegions() {
  return <div className="cdx-sr" aria-live="assertive" aria-atomic="true" data-live="assertive" />
}
