/**
 * The Conductor tab root: a compact header (context numbers, New context,
 * the "..." menu, reset progress and result) and five sub-tabs, one panel
 * at a time: Context, Pins, Inbox, History, Agents. The last sub-tab is
 * remembered per chat. Polls only while visible: 1.5 s while a reset runs,
 * 4 s while something is working, 15 s when idle; an unchanged fingerprint
 * re-renders nothing.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sessionApi, errorText } from './api.js'
import {
  sessionModel, refreshStatus, refreshSettings, settingsModel, statusModel, prefs, pref, requests, takeRequest, moduleOn, runningCount,
  setupRerun, setupNeeded,
} from './store.js'
import { SetupGuide } from './setup.jsx'
import { ensureStyles } from './styles.js'
import { Skeleton, Note, useSignal } from './ui.jsx'
import { Meter, ResetBar, isCancelled } from './header.jsx'
import { ToastHost, LiveRegions, toast, latestUndo, runUndo } from './toasts.jsx'
import { ContextPanel } from './sections/context.jsx'
import { PinsSection } from './sections/pins.jsx'
import { InboxSection } from './sections/inbox.jsx'
import { HistoryPanel } from './sections/history.jsx'
import { OrchestrationSection, runningNow } from './sections/orchestration.jsx'
import { AutomationPanel } from './sections/automation.jsx'
import { firstLine } from './format.js'

export const SUBTABS = ['context', 'pins', 'inbox', 'history', 'agents']
export const SUBTAB_TITLES = { context: 'Context', pins: 'Pins', inbox: 'Inbox', history: 'History', agents: 'Agents' }
/** Older section names (slash commands, saved tabs) and where they live now. */
const ALIASES = { versions: 'history', epochs: 'history', activity: 'history' }
export const SECTION_IDS = [...SUBTABS, ...Object.keys(ALIASES)]

export function subtabOf(section) {
  const id = ALIASES[section] || section
  return SUBTABS.includes(id) ? id : null
}

const LAST_KEY = 'dsh-conductor:subtab'
function loadLast(sessionId) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) || '{}')
    return all && typeof all === 'object' ? subtabOf(all[sessionId]) : null
  } catch { return null }
}
function saveLast(sessionId, id) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) || '{}') || {}
    delete all[sessionId]
    all[sessionId] = id
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k] // keep the newest 200 chats
    localStorage.setItem(LAST_KEY, JSON.stringify(all))
  } catch { /* private mode */ }
}

function inTextField(target) {
  return Boolean(target && target.closest && target.closest('input:not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable=""],[contenteditable=true]'))
}

/** Keep the prefs signal in step with the Better Sidebar pluginSettings of this tab. */
function usePrefsBridge(store, tabId) {
  useEffect(() => {
    if (!store || typeof store.getSnapshot !== 'function') return undefined
    const read = () => {
      try {
        const snap = store.getSnapshot()
        const blob = snap && snap.prefs && snap.prefs.pluginSettings && snap.prefs.pluginSettings[tabId]
        if (blob && typeof blob === 'object' && blob !== prefs.get()) prefs.set(blob)
      } catch { /* prefs are optional */ }
    }
    read()
    return typeof store.subscribe === 'function' ? store.subscribe(read) : undefined
  }, [store, tabId])
}

export function ConductorTab({ sessionId, visible, store, tab, tabId, services }) {
  useEffect(() => { ensureStyles() }, [])
  usePrefsBridge(store, tabId)
  if (!sessionId) {
    return <div className="cdx"><div className="cdx-center">Open a chat to use Conductor.</div></div>
  }
  return <ConductorSession key={sessionId} sessionId={sessionId} visible={visible} tab={tab} services={services} />
}

/** The segmented sub-tab bar (WAI-ARIA tabs: arrows, Home and End move and activate). */
function SubTabs({ tabs, active, onSelect, counts, uid }) {
  const refs = useRef({})
  const onKeyDown = (e) => {
    const i = tabs.indexOf(active)
    let next = null
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length]
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length]
    else if (e.key === 'Home') next = tabs[0]
    else if (e.key === 'End') next = tabs[tabs.length - 1]
    if (!next) return
    e.preventDefault()
    onSelect(next)
    const el = refs.current[next]
    if (el) el.focus()
  }
  return (
    <div className="cdx-tabs" role="tablist" aria-label="Conductor" onKeyDown={onKeyDown}>
      {tabs.map((id) => (
        <button key={id} type="button" role="tab" id={uid + '-tab-' + id} aria-controls={uid + '-panel-' + id}
          aria-selected={active === id} tabIndex={active === id ? 0 : -1} data-subtab={id}
          ref={(el) => { refs.current[id] = el }} onClick={() => onSelect(id)}>
          {SUBTAB_TITLES[id]}{counts[id] ? <span className={'cdx-tcount' + (counts[id].live ? ' live' : '')}>{counts[id].n}</span> : null}
        </button>
      ))}
    </div>
  )
}

function ConductorSession({ sessionId, visible, tab, services }) {
  const model = useMemo(() => sessionModel(sessionId), [sessionId])
  const api = useMemo(() => sessionApi(sessionId), [sessionId])
  const snap = useSignal(model)
  const settings = useSignal(settingsModel)
  const status = useSignal(statusModel)
  const req = useSignal(requests)
  useSignal(prefs)
  useSignal(setupRerun)
  const view = snap.view
  const [active, setActive] = useState(() => loadLast(sessionId) || 'context')
  const [filter, setFilter] = useState(null)
  const [reset, setReset] = useState(null) // { kind, at, baseline }
  const [refreshing, setRefreshing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [dismissedResult, setDismissedResult] = useState(null)
  const [panelOverride, setPanelOverride] = useState(null) // 'automation' replaces the sub-tabs
  const lastUnread = useRef(null)
  const panelRef = useRef(null)
  const uid = useMemo(() => 'cdx' + Math.random().toString(36).slice(2, 8), [])

  // ── loading and polling ──────────────────────────────────────────────
  useEffect(() => { if (settings.status === 'idle') refreshSettings() }, [])
  const busy = Boolean(reset) || Boolean(view && view.progress)
  const working = Boolean(view && (view.status === 'running' || (view.pending && (view.pending.steps || view.pending.afterTurn)))) || runningCount() > 0
  const autoPoll = pref('autoPoll') !== false
  useEffect(() => {
    if (!visible) return undefined
    let stopped = false
    let timer = null
    const tick = async () => {
      await Promise.all([model.refresh().catch(() => null), moduleOn('orchestration') ? refreshStatus() : null])
      if (stopped || !autoPoll) return
      timer = setTimeout(tick, busy ? 1500 : working ? 4000 : 15000)
    }
    tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [visible, model, busy, working, autoPoll])

  const manualRefresh = useCallback(async () => {
    setRefreshing(true)
    try { await Promise.all([model.refresh(), refreshStatus(), refreshSettings()]) } catch { /* shown by the state */ } finally { setRefreshing(false) }
  }, [model])

  // ── reset lifecycle (/new, /clear, /force-compact) ───────────────────
  const onReset = useCallback(async (kind) => {
    const baseline = view && view.lastReset ? view.lastReset.id : null
    setReset({ kind, at: Date.now(), baseline })
    setDismissedResult(null)
    try {
      await api.reset(kind)
      model.refresh().catch(() => {})
    } catch (e) {
      setReset(null)
      toast({ tone: 'error', message: (kind === 'new' ? 'Could not start /new. ' : kind === 'clear' ? 'Could not clear the context. ' : 'Could not compact. ') + errorText(e), sessionId })
    }
  }, [api, model, view, sessionId])

  const onCancelReset = useCallback(async () => {
    setCancelling(true)
    try {
      await api.cancelReset()
    } catch (e) {
      toast({ tone: 'error', message: 'Could not cancel. ' + errorText(e), sessionId })
    } finally {
      setCancelling(false)
      model.refresh().catch(() => {})
    }
  }, [api, model, sessionId])

  useEffect(() => {
    if (!reset || !view) return
    const last = view.lastReset
    if (view.progress || !last || last.id === reset.baseline) return
    setReset(null)
    if (last.ok) toast({ message: firstLine(last.text, 200) || 'Context reset.', sessionId, ms: 6000 })
    else if (isCancelled(last)) toast({ message: firstLine(last.text, 200), sessionId })
    else toast({ tone: 'error', message: firstLine(last.text, 300) || 'The reset failed. Your context is unchanged.', sessionId })
  }, [view, reset, sessionId])

  // ── sub-tabs ─────────────────────────────────────────────────────────
  const tabs = useMemo(() => {
    const list = ['context']
    if (moduleOn('pins')) list.push('pins')
    if (moduleOn('posts')) list.push('inbox')
    list.push('history')
    if (moduleOn('orchestration')) list.push('agents')
    return list
  }, [settings])
  const current = tabs.includes(active) ? active : 'context'
  const select = useCallback((id) => {
    setActive(id)
    saveLast(sessionId, id)
  }, [sessionId])
  const reveal = useCallback((section) => {
    const id = subtabOf(section)
    if (!id) return
    setPanelOverride(null)
    select(id)
    const go = () => { const btn = document.getElementById(uid + '-tab-' + id); if (btn) btn.focus({ preventScroll: true }) }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go); else go()
  }, [select, uid])

  // requests from slash commands (module request or tab.meta)
  useEffect(() => {
    const hit = takeRequest(sessionId)
    if (hit) reveal(hit.section)
  }, [req, sessionId, reveal])
  const metaSection = tab && tab.meta && tab.meta.section
  const metaAt = tab && tab.meta && tab.meta.at
  useEffect(() => { if (metaSection) reveal(metaSection) }, [metaSection, metaAt])

  // optionally switch to the Inbox when something new arrives (never steals focus)
  useEffect(() => {
    if (!view) return
    const unread = view.unread || 0
    if (lastUnread.current !== null && unread > lastUnread.current && pref('autoOpenInbox') && tabs.includes('inbox')) select('inbox')
    lastUnread.current = unread
  }, [view && view.unread])

  // ── keyboard (focus within the tab only) ─────────────────────────────
  const onKeyDown = (e) => {
    if (e.defaultPrevented) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && !inTextField(e.target)) {
      const t = latestUndo(sessionId)
      if (t) { e.preventDefault(); runUndo(t.id) }
      return
    }
    // Alt+1 to Alt+5 jump to a sub-tab
    if (e.altKey && !mod && /^[1-5]$/.test(e.key)) {
      const id = tabs[Number(e.key) - 1]
      if (id) { e.preventDefault(); reveal(id) }
    }
  }

  const openFile = useCallback((path) => {
    if (!path) return
    try {
      if (services.sidebar && typeof services.sidebar.openFile === 'function') { services.sidebar.openFile({ sessionId }, path); return }
    } catch (e) { console.warn('[dsh-conductor] openFile failed', e) }
    toast({ tone: 'error', message: 'Could not open ' + path + ' in the sidebar.', sessionId })
  }, [services, sessionId])
  const openSession = useCallback((id) => {
    const ws = services.workspace && services.workspace()
    try {
      if (ws && typeof ws.openSession === 'function') { ws.openSession(id); return }
    } catch (e) { console.warn('[dsh-conductor] openSession failed', e) }
    toast({ tone: 'error', message: 'This DSH build cannot switch chats from a plugin. Chat id: ' + id, sessionId })
  }, [services, sessionId])

  // ── render ───────────────────────────────────────────────────────────
  const guide = setupNeeded()
  const error = snap.error
  if (!view) {
    return (
      <div className="cdx">
        <div className="cdx-head">{snap.status === 'error' ? null : <Skeleton rows={2} />}</div>
        <div className="cdx-body">
          {snap.status === 'error' ? <OfflineNote error={error} onRetry={manualRefresh} /> : <Skeleton rows={4} />}
        </div>
        <LiveRegions />
      </div>
    )
  }

  const now = status.data ? runningNow(status.data) : { agents: [], tasks: [] }
  const counts = {
    pins: (view.pins || []).length ? { n: view.pins.length } : null,
    inbox: view.unread ? { n: view.unread, live: true } : null,
    agents: now.agents.length + now.tasks.length ? { n: now.agents.length + now.tasks.length, live: true } : null,
  }
  const panelProps = { sessionId, view, api, model, openFile, openSession }
  if (guide) {
    return (
      <div className="cdx" onKeyDown={onKeyDown} data-conductor-root>
        <header className="cdx-head">
          <Meter view={view} onFilter={(f) => setFilter(f)} />
          <ResetBar view={view} fetchedAt={snap.viewAt} reset={reset} onReset={onReset} onCancel={onCancelReset} cancelling={cancelling}
            onRefresh={manualRefresh} refreshing={refreshing}
            resultDismissed={view.lastReset && dismissedResult === view.lastReset.id}
            onDismissResult={() => setDismissedResult(view.lastReset && view.lastReset.id)} openFile={openFile} onSetup={null} />
        </header>
        <div className="cdx-body" data-panel="setup">
          <SetupGuide settings={settings.data} onDone={() => select('context')} />
          <div style={{ height: 56 }} aria-hidden="true" />
        </div>
        <ToastHost sessionId={sessionId} />
        <LiveRegions />
      </div>
    )
  }
  const panel = () => {
    switch (current) {
      case 'pins': return <PinsSection {...panelProps} />
      case 'inbox': return <InboxSection {...panelProps} />
      case 'history': return <HistoryPanel {...panelProps} putDraft={services.putDraft ? services.putDraft() : null} />
      case 'agents': return <OrchestrationSection sessionId={sessionId} openSession={openSession} />
      default: return <ContextPanel {...panelProps} filter={filter} onFilter={setFilter} busyAgent={view.status === 'running'} />
    }
  }

  return (
    <div className="cdx" onKeyDown={onKeyDown} data-conductor-root>
      <header className="cdx-head">
        <Meter view={view} onFilter={(f) => { setPanelOverride(null); setFilter(f); reveal('context') }} onAutomation={() => setPanelOverride('automation')} />
        <ResetBar view={view} fetchedAt={snap.viewAt} reset={reset} onReset={onReset} onCancel={onCancelReset} cancelling={cancelling}
          onRefresh={manualRefresh} refreshing={refreshing}
          resultDismissed={view.lastReset && dismissedResult === view.lastReset.id}
          onDismissResult={() => setDismissedResult(view.lastReset && view.lastReset.id)} openFile={openFile}
          onSetup={guide ? null : () => setupRerun.set(true)} onAutomation={() => setPanelOverride('automation')} />
        {view.pending && view.pending.afterTurn ? <div className="cdx-help" style={{ marginTop: 8 }}>{'/' + view.pending.afterTurn + ' runs when the current turn ends.'}</div> : null}
      </header>
      {error ? <OfflineNote error={error} onRetry={manualRefresh} compact /> : null}
      {panelOverride === 'automation' ? (
        <div className="cdx-body" data-panel="automation">
          <AutomationPanel sessionId={sessionId} view={view} api={api} model={model} onBack={() => setPanelOverride(null)} />
          <div style={{ height: 56 }} aria-hidden="true" />
        </div>
      ) : null}
      {panelOverride === 'automation' ? null : <SubTabs tabs={tabs} active={current} onSelect={(id) => { setPanelOverride(null); select(id) }} counts={counts} uid={uid} />}
      {panelOverride === 'automation' ? null : <div className="cdx-body" role="tabpanel" id={uid + '-panel-' + current} aria-labelledby={uid + '-tab-' + current}
        data-panel={current} ref={panelRef} tabIndex={-1}>
        {panel()}
        <div style={{ height: 56 }} aria-hidden="true" />
      </div>}
      <ToastHost sessionId={sessionId} />
      <LiveRegions />
    </div>
  )
}

function OfflineNote({ error, onRetry, compact }) {
  if (error && error.offline) {
    return <Note tone="warn" role="alert" actions={<button type="button" className="cdx-btn s" onClick={onRetry}>Retry now</button>}>
      {'Conductor can\u2019t reach its service. It will keep retrying.'}{compact ? ' The numbers above may be stale.' : ''}
    </Note>
  }
  if (error && error.status === 404) {
    return <Note tone="warn" actions={<button type="button" className="cdx-btn s" onClick={onRetry}>Retry</button>}>
      This chat is not loaded on the server yet. Send a message or reopen the chat, then retry.
    </Note>
  }
  return <Note tone="bad" role="alert" actions={<button type="button" className="cdx-btn s" onClick={onRetry}>Retry</button>}>
    {'Couldn\u2019t load Conductor. ' + errorText(error)}
  </Note>
}
