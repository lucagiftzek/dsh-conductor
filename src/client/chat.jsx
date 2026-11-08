/**
 * Conductor in the main chat.
 *
 * 1. Ghosts: a silent post is a user/message whose source kind is
 *    'dsh-conductor-post'. Chat would classify it as hidden context, so an
 *    exclusive Chat event Definition claims it and builds a node of our own
 *    kind, rendered by a keyed 'conversation.chat.node' entry as a message
 *    bubble (sender, time, a "Ghost" label, Report or Alert).
 *
 * 2. Edited messages: Chat renders only append-origin events, so an edit
 *    (a surface replacement) never reaches the transcript. Shadowing entries
 *    for the 'user' and 'assistant-step' keys delegate to the built-in
 *    renderer found through ctx.slots.entries(), with the node's text swapped
 *    for the current version. A "v2" marker opens the version list.
 *
 * Every seam degrades without breaking the chat: no uiConversation, no
 * slots, no built-in renderer to delegate to, or a crash (the slot boundary
 * retires the entry and the built-in renderer wins again) all leave the stock
 * chat untouched. The edit seam is not silent about it: `shadowHealth`
 * records whether the shadow renderers are registered and have rendered an
 * edited node, and the Conductor tab shows a notice (plus one console
 * warning) when an edited message exists and the chat cannot show it.
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { sessionModel, moduleOn, settingsModel, createSignal } from './store.js'
import { sessionApi, errorText } from './api.js'
import { ensureStyles } from './styles.js'
import { fmtHM, fmtWhen } from './format.js'
import { useSignal } from './ui.jsx'

export const GHOST_KIND = 'conductor-ghost'
export const GHOST_SOURCE = 'dsh-conductor-post'
export const REWIND_KIND = 'conductor-rewind'
export const REWIND_SOURCE = 'dsh-conductor-rewind'
const NODE_SLOT = 'conversation.chat.node'
/** Keyed cells render their lowest priority entry; the built-in renderers sit at 0. */
const SHADOW_PRIORITY = -100

// ── health of the edited-message seam ──────────────────────────────────

/** localStorage switch that simulates a DSH without the seam (QA and screenshots). */
export const SIMULATE_KEY = 'dsh-conductor:simulate-no-chat-shadow'
export const FALLBACK_NOTICE = 'This DSH version does not let Conductor show edited text in the chat; the model still sees the new text. Versions are listed here.'
const SHADOW_KEYS = { user: 'user', assistant: 'assistant-step' }
/** How long a registered shadow may go without rendering any node before it counts as bypassed. */
export const SHADOW_GRACE_MS = 15000

/**
 * state: 'active' (registered and has rendered an edited node),
 * 'unavailable' (the built-in renderers could not be captured or registration
 * failed), 'unverified' (anything else, for example no edited message yet).
 */
export const shadowHealth = createSignal({ state: 'unverified', reason: '', registered: {}, rendered: {}, since: 0 })

function setHealth(patch) {
  const cur = shadowHealth.get()
  const next = { ...cur, ...patch, registered: { ...cur.registered, ...(patch.registered || {}) }, rendered: { ...cur.rendered, ...(patch.rendered || {}) } }
  if (cur.state === 'unavailable' && next.state !== 'unavailable') next.state = 'unavailable' // a failure is sticky for this page
  if (JSON.stringify(next) !== JSON.stringify(cur)) shadowHealth.set(next)
}

function markUnavailable(reason) {
  setHealth({ state: 'unavailable', reason })
}

function simulated() {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(SIMULATE_KEY) === '1' } catch { return false }
}

/** Reset (tests). */
export function resetShadowHealth() {
  shadowHealth.set({ state: 'unverified', reason: '', registered: {}, rendered: {}, since: 0 })
  warned.clear()
}

/** Called by a shadow renderer after it rendered a node (edited or not). */
function useRenderedMark(key, edited) {
  useEffect(() => {
    const cur = shadowHealth.get()
    if (!cur.rendered[key]) setHealth({ rendered: { [key]: true } })
    if (edited && cur.state === 'unverified') setHealth({ state: 'active', reason: '' })
  }, [key, edited])
}

const warned = new Set()

/**
 * Why the open chat cannot show its edited messages, or null when it can (or
 * when nothing is edited). Warns once per reason in the console.
 */
export function editFallbackReason(view, health = shadowHealth.get(), now = Date.now()) {
  if (!view || !moduleOn('versions')) return null
  const edited = (view.versions || []).filter((e) => (e.versions || []).length > 1)
  if (!edited.length) return null
  let reason = null
  if (health.state === 'active') return null
  if (health.state === 'unavailable') reason = health.reason || 'the chat renderers could not be extended'
  else {
    for (const e of edited) {
      const key = SHADOW_KEYS[e.role === 'user' ? 'user' : 'assistant']
      if (health.registered[key] && !health.rendered[key] && health.since && now - health.since > SHADOW_GRACE_MS) {
        reason = 'the chat no longer renders messages through the "' + key + '" renderer Conductor extends'
        break
      }
    }
  }
  if (reason && !warned.has(reason)) {
    warned.add(reason)
    console.warn('[dsh-conductor] edited messages show their original text in the chat: ' + reason + '. The model still sees the edited text; versions are listed in Conductor, History.')
  }
  return reason
}

/** Hook form of editFallbackReason, re-evaluated as the health changes and once the grace period ends. */
export function useEditFallback(view) {
  const health = useSignal(shadowHealth)
  const [, tick] = useState(0)
  useEffect(() => {
    if (health.state !== 'unverified' || !health.since) return undefined
    const left = SHADOW_GRACE_MS - (Date.now() - health.since) + 50
    if (left <= 0) return undefined
    const t = setTimeout(() => tick((n) => n + 1), left)
    return () => clearTimeout(t)
  }, [health])
  return editFallbackReason(view, health)
}

const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '')

const GHOST_HEADER = /^\[Silent message from (.+?)(?:, (report|alert|note))?, (\d{4}-\d\d-\d\dT[0-9:.]+Z?)\. It did not wake you; take it into account when relevant\.\]\s*\n?/

/** Split a ghost's model-facing text into its parts (the header is for the model only). */
export function parseGhost(text) {
  const raw = String(text || '')
  const m = raw.match(GHOST_HEADER)
  if (!m) return { from: '', kind: 'note', at: '', body: raw }
  return { from: m[1], kind: m[2] || 'note', at: m[3], body: raw.slice(m[0].length) }
}

/** Chat event Definition: claims ghost messages before Chat files them as hidden context. */
export const ghostDefinition = {
  kind: GHOST_KIND,
  target: 'chat',
  match: (event) => {
    if (!event || event.type !== 'user/message' || event.surfaceOp !== 'append') return null
    const source = event.data && event.data.source
    if (!source || source.kind !== GHOST_SOURCE) return null
    return { id: String(event.data.id), role: 'start', exclusive: true }
  },
  start: (_context, match) => {
    const event = match.event
    const parsed = parseGhost(textOf(event.data.content))
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      summary: event.data.source.summary || '',
      ...parsed,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: GHOST_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: (context.start && context.start.location) || { kind: 'unresolved' },
      visibility: 'visible',
      groupTree: 'input',
      data: context.state,
    }
  },
}

/** The label a rewind notice names ("Rewound to: <label>", or from its text). */
export function rewindLabel(data) {
  const summary = data && data.source && data.source.summary
  if (typeof summary === 'string' && summary.startsWith('Rewound to: ')) return summary.slice(12)
  const m = textOf(data && data.content).match(/checkpoint before "([^"]*)"/)
  return m ? m[1] : ''
}

/**
 * Chat event Definition for rewind notices. They are surface replacements
 * (model-facing), which Chat never shows; this claims them and builds a thin
 * divider, so the user sees where the chat was rewound.
 */
export const rewindDefinition = {
  kind: REWIND_KIND,
  target: 'chat',
  match: (event) => {
    if (!event || event.type !== 'user/message') return null
    const source = event.data && event.data.source
    if (!source || source.kind !== REWIND_SOURCE) return null
    return { id: String(event.data.id), role: 'start', exclusive: true }
  },
  start: (_context, match) => ({ seq: match.event.seq, time: match.event.time, label: rewindLabel(match.event.data) }),
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: REWIND_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location: (context.start && context.start.location) || { kind: 'unresolved' },
      visibility: 'visible',
      groupTree: 'input',
      data: context.state,
    }
  },
}

export function RewindDivider({ node, sessionId, openSection }) {
  useEffect(() => { ensureStyles() }, [])
  const data = (node && node.data) || {}
  return (
    <div className="cdx-rewound" role="separator" aria-label={'Rewound to before ' + (data.label || 'a checkpoint')} data-conductor-rewind>
      <span className="cdx-rewound-line" aria-hidden="true" />
      <button type="button" className="cdx-rewound-text" disabled={!sessionId} title={fmtWhen(data.time) + '. Show checkpoints in Conductor, History.'}
        onClick={() => sessionId && openSection(sessionId, 'history')}>
        {'Rewound to before "' + (data.label || 'a checkpoint') + '"'}
      </button>
      <span className="cdx-rewound-line" aria-hidden="true" />
    </div>
  )
}

// ── shared session data ────────────────────────────────────────────────

/** Version entry of one message from the chat's Conductor view (null when unedited). */
function useVersionEntry(sessionId, pick) {
  const model = sessionId ? sessionModel(sessionId) : null
  useEffect(() => { if (model) model.ensure(60000) }, [model])
  const subscribe = useCallback((fn) => (model ? model.subscribe(fn) : () => {}), [model])
  const get = () => {
    const view = model && model.getSnapshot().view
    if (!view || !Array.isArray(view.versions)) return null
    const entry = view.versions.find(pick)
    return entry && Array.isArray(entry.versions) && entry.versions.length > 1 ? entry : null
  }
  return useSyncExternalStore(subscribe, get, get)
}

function currentVersion(entry) {
  const list = entry.versions
  return list.find((v) => v.v === entry.current) || list[list.length - 1]
}

// ── version marker and popover ─────────────────────────────────────────

function authorOf(v) {
  if (v.author === 'original') return 'original'
  return v.author === 'model' ? 'by the assistant' : 'by you'
}

export function VersionMarker({ sessionId, entry, onOpenTab, align }) {
  useEffect(() => { ensureStyles() }, [])
  const [open, setOpen] = useState(false)
  const [down, setDown] = useState(false)
  const [busy, setBusy] = useState(0)
  const [note, setNote] = useState('')
  const ref = useRef(null)
  const cur = currentVersion(entry)
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  const restore = async (v) => {
    setBusy(v.v)
    setNote('')
    try {
      const r = await sessionApi(sessionId).restore(entry.messageId, v.v)
      setNote('Restored version ' + v.v + ' as version ' + r.version + '.')
    } catch (e) {
      setNote('Could not restore: ' + errorText(e))
    } finally {
      setBusy(0)
      sessionModel(sessionId).refresh().catch(() => {})
    }
  }
  return (
    <span className={'cdx-vmark' + (align === 'end' ? ' end' : '')} ref={ref} data-conductor-version={entry.messageId}>
      <button type="button" className="cdx-vchip" aria-haspopup="dialog" aria-expanded={open}
        title={'Edited: the model sees version ' + cur.v + '. Show all versions.'}
        aria-label={'Edited message, version ' + cur.v + ' of ' + entry.versions.length + '. Show versions'}
        onClick={() => {
          // open upward unless the chat has too little room above the marker
          if (!open && ref.current) setDown(ref.current.getBoundingClientRect().top < 340)
          setOpen(!open)
        }}>{'v' + cur.v}</button>
      {open ? (
        <span className={'cdx-vpop' + (down ? ' down' : '')} role="dialog" aria-label="Message versions">
          {[...entry.versions].reverse().map((v) => (
            <span key={v.v} className="cdx-vpop-row">
              <span className="cdx-vpop-head">
                <b>{'v' + v.v}</b>
                <span>{authorOf(v) + (v.reason ? ': ' + v.reason : '') + ' \u00b7 ' + fmtWhen(v.at)}</span>
                {v.v === cur.v ? <span className="cdx-vpop-cur">current</span>
                  : <button type="button" className="cdx-vpop-btn" disabled={busy !== 0} onClick={() => restore(v)}>{busy === v.v ? 'Restoring\u2026' : 'Restore'}</button>}
              </span>
              <span className="cdx-vpop-text">{v.text.length > 600 ? v.text.slice(0, 600) + '\u2026' : v.text}</span>
            </span>
          ))}
          {note ? <span className="cdx-vpop-note" role="status">{note}</span> : null}
          {onOpenTab ? <button type="button" className="cdx-vpop-link" onClick={() => { setOpen(false); onOpenTab() }}>Compare in Conductor</button> : null}
        </span>
      ) : null}
    </span>
  )
}

// ── shadowing renderers for edited messages ────────────────────────────

/** Swap a user node's text for the current version (attachments and other blocks stay). */
export function patchUserNode(node, text) {
  const data = node.data || {}
  const content = Array.isArray(data.content) ? data.content : []
  const rest = content.filter((b) => !b || b.type !== 'text')
  return { ...node, data: { ...data, content: [{ type: 'text', text }, ...rest] } }
}

/** Swap an assistant step's answer text for the current version (reasoning and images stay). */
export function patchAssistantNode(node, text) {
  const data = node.data || {}
  const blocks = Array.isArray(data.blocks) ? data.blocks : []
  const out = []
  let placed = false
  for (const b of blocks) {
    if (b && b.kind === 'text') {
      if (!placed) { out.push({ kind: 'text', text }); placed = true }
      continue
    }
    out.push(b)
  }
  if (!placed) out.push({ kind: 'text', text })
  const finalNode = data.finalNode ? { ...data.finalNode, blocks: out } : data.finalNode
  return { ...node, data: { ...data, blocks: out, finalNode } }
}

/** Register the ghost Definition on the Conversation event registry (a Cordis effect of `scope`). */
export function registerGhostDefinition(uiConversation, scope, effect, warn) {
  if (!uiConversation || !uiConversation.events || typeof uiConversation.events.register !== 'function') {
    warn('uiConversation.events unavailable; silent messages stay out of the chat view')
    return
  }
  effect(scope, () => uiConversation.events.register(ghostDefinition), 'dsh-conductor: ghost messages in chat')
  effect(scope, () => uiConversation.events.register(rewindDefinition), 'dsh-conductor: rewind dividers in chat')
}

/**
 * Register the chat renderers: the ghost bubble and the shadowing renderers
 * for edited messages. Every registration rides `effect`, so a reload
 * removes it.
 */
export function registerChatRenderers(ctx, slots, effect, warn, openSection) {
  const ours = new Set()

  // 1. the ghost bubble (the kind exists only when the ghost Definition is registered)
  const GhostNode = function ConductorGhostNode(props) {
    return <GhostView node={props.node} sessionId={props.conductorSessionId} openSection={openSection} />
  }
  ours.add(GhostNode)
  effect(ctx, () => slots.inject(NODE_SLOT, () => slots.register({
    name: NODE_SLOT,
    key: GHOST_KIND,
    inject: (sessionId) => ({ conductorSessionId: sessionId }),
  }, GhostNode)), 'dsh-conductor: ghost renderer')
  const RewindNode = function ConductorRewindNode(props) {
    return <RewindDivider node={props.node} sessionId={props.conductorSessionId} openSection={openSection} />
  }
  ours.add(RewindNode)
  effect(ctx, () => slots.inject(NODE_SLOT, () => slots.register({
    name: NODE_SLOT,
    key: REWIND_KIND,
    inject: (sessionId) => ({ conductorSessionId: sessionId }),
  }, RewindNode)), 'dsh-conductor: rewind divider renderer')

  // 2. edited user messages and assistant answers: shadow the built-in
  // renderer of a key and delegate to it. The registry lists only the winner
  // of each key, so the built-in entry is captured BEFORE ours shadows it;
  // without one there is nothing to delegate to and nothing is registered.
  if (simulated()) {
    markUnavailable('simulated with localStorage "' + SIMULATE_KEY + '"')
    return
  }
  if (typeof slots.entries !== 'function') {
    markUnavailable('this DSH build does not list slot entries (slots.entries)')
    warn('slots.entries unavailable; edited messages keep their original text in the chat view')
    return
  }
  const capture = (key) => {
    let list
    try { list = slots.entries(NODE_SLOT) } catch { list = null }
    if (!Array.isArray(list)) return null
    const entry = list.find((e) => e && e.component && e.options && e.options.key === key && !ours.has(e.component))
    return entry ? { component: entry.component, inject: entry.inject, children: entry.children, locale: entry.locale } : null
  }
  /**
   * Register once the built-in entry exists. Chat registers its renderers
   * when the slot is declared, which may be after this callback runs, so
   * retry on registry changes and on a short bounded timer.
   */
  const shadow = (key, make, label) => {
    effect(ctx, () => slots.inject(NODE_SLOT, () => {
      let dispose = null
      let stop = null
      let timer = null
      let tries = 0
      let disposed = false
      const cleanup = () => {
        if (stop) { try { stop() } catch { /* already gone */ } stop = null }
        if (timer) { clearTimeout(timer); timer = null }
      }
      const attempt = () => {
        if (dispose || disposed) return true
        const base = capture(key)
        if (!base) return false
        const { options, component } = make(base)
        ours.add(component)
        try {
          // keyed cells shadow by priority, lowest renders: the built-in sits at 0
          dispose = slots.register({ name: NODE_SLOT, key, priority: SHADOW_PRIORITY, ...options }, component)
        } catch (error) {
          cleanup()
          markUnavailable('registering the "' + key + '" renderer failed: ' + String((error && error.message) || error))
          warn('could not shadow the "' + key + '" chat renderer (' + String((error && error.message) || error) + '); edited messages keep their original text')
          disposed = true
          return true
        }
        setHealth({ registered: { [key]: true }, since: shadowHealth.get().since || Date.now() })
        cleanup()
        return true
      }
      const retry = () => {
        timer = null
        if (attempt()) return
        tries += 1
        if (tries < 120) {
          timer = setTimeout(retry, 250)
          if (timer && typeof timer.unref === 'function') timer.unref()
        } else {
          cleanup()
          markUnavailable('no built-in "' + key + '" chat renderer to delegate to')
          warn('no built-in "' + key + '" chat renderer to delegate to; edited messages keep their original text')
        }
      }
      if (!attempt()) {
        if (typeof slots.subscribe === 'function') {
          try { stop = slots.subscribe(NODE_SLOT, () => { attempt() }) } catch { stop = null }
        }
        timer = setTimeout(retry, 0)
        if (timer && typeof timer.unref === 'function') timer.unref()
      }
      return () => {
        disposed = true
        cleanup()
        if (dispose) dispose()
        dispose = null
      }
    }), label)
  }

  shadow('user', (base) => {
    const Base = base.component
    const component = React.memo(function ConductorEditedUser(props) {
      const sessionId = props.conductorSessionId
      const seq = props.node && props.node.data && props.node.data.seq
      useSignal(settingsModel)
      const entry = useVersionEntry(moduleOn('versions') ? sessionId : null, (e) => e.role === 'user' && e.origSeq === seq)
      useRenderedMark('user', Boolean(entry))
      if (!entry) return <Base {...props} />
      return (
        <div className="cdx-edited user" data-conductor-edited={entry.messageId}>
          <Base {...props} node={patchUserNode(props.node, currentVersion(entry).text)} />
          <VersionMarker sessionId={sessionId} entry={entry} align="end" onOpenTab={() => openSection(sessionId, 'history')} />
        </div>
      )
    })
    return { component, options: { ...(base.locale ? { locale: base.locale } : {}), inject: mergeInject(base.inject) } }
  }, 'dsh-conductor: edited user messages')

  shadow('assistant-step', (base) => {
    const Base = base.component
    const component = React.memo(function ConductorEditedAssistant(props) {
      const sessionId = props.conductorSessionId
      const final = props.node && props.node.data && props.node.data.finalNode
      const messageId = final && final.messageId
      useSignal(settingsModel)
      const entry = useVersionEntry(moduleOn('versions') && messageId ? sessionId : null, (e) => e.messageId === messageId)
      // The built-in entry declares the child slots; ours cannot declare them
      // again, so its two children render through the same Factories their
      // shipped occupants use (or the current occupant, when one is registered).
      const renderSlot = useChildSlots(slots, props.renderFactorySlot)
      useRenderedMark('assistant-step', Boolean(entry) && props.groupPart !== 'reasoning')
      if (!entry || props.groupPart === 'reasoning') return <Base {...props} renderSlot={renderSlot} />
      return <Base {...props} renderSlot={renderSlot} node={patchAssistantNode(props.node, currentVersion(entry).text)} />
    })
    return { component, options: { ...(base.locale ? { locale: base.locale } : {}), inject: mergeInject(base.inject) } }
  }, 'dsh-conductor: edited assistant answers')
}

/** Child slots of the assistant renderer and the Factory their shipped occupant calls. */
const CHILD_FACTORIES = {
  'conversation.chat.reasoning.body': (owner) => ['conversation.chat.reasoning.content', { text: owner.text, running: owner.running }],
  'conversation.chat.message.images': (owner) => ['conversation.images.content', owner],
}

class ChildBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false } }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { /* fall back to the Factory */ }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

/** A renderSlot for the assistant renderer's two child slots. */
export function useChildSlots(slots, renderFactorySlot) {
  return React.useMemo(() => (key, owner, opts) => {
    const viaFactory = () => {
      const make = CHILD_FACTORIES[key]
      if (!make || typeof renderFactorySlot !== 'function') return (opts && opts.fallback) || null
      const [name, props] = make(owner || {})
      return renderFactorySlot(name, props)
    }
    let winner = null
    try {
      const list = typeof slots.entries === 'function' ? slots.entries(key) : []
      winner = Array.isArray(list) ? [...list].sort((a, b) => ((a.options && a.options.priority) ?? 0) - ((b.options && b.options.priority) ?? 0))[0] : null
    } catch { winner = null }
    if (!winner || !winner.component) return viaFactory()
    const Occupant = winner.component
    return <ChildBoundary fallback={viaFactory()}><Occupant {...(owner || {})} renderFactorySlot={renderFactorySlot} /></ChildBoundary>
  }, [slots, renderFactorySlot])
}

/** The built-in entry's own injection (hooks it needs) plus the chat id for ours. */
function mergeInject(baseInject) {
  return (...args) => {
    let injected = {}
    try { injected = typeof baseInject === 'function' ? baseInject(...args) || {} : {} } catch { injected = {} }
    return { ...injected, conductorSessionId: args[0] }
  }
}

/** The version marker in an assistant answer's action row (beside the star). */
export function AssistantVersionAction({ messageId, sessionId, openSection }) {
  useSignal(settingsModel)
  const entry = useVersionEntry(moduleOn('versions') && messageId ? sessionId : null, (e) => e.messageId === messageId)
  if (!entry) return null
  return <VersionMarker sessionId={sessionId} entry={entry} onOpenTab={() => openSection(sessionId, 'history')} />
}

// ── ghost bubble ───────────────────────────────────────────────────────

export function GhostView({ node, sessionId, openSection }) {
  useEffect(() => { ensureStyles() }, [])
  const data = (node && node.data) || {}
  const kind = data.kind === 'report' || data.kind === 'alert' ? data.kind : null
  const when = data.at || data.time
  return (
    <div className="cdx-ghost" data-conductor-ghost={data.messageId}>
      <div className="cdx-ghost-meta">
        <span className="cdx-ghost-from" title={data.from || data.summary}>{data.from || 'another chat'}</span>
        <span className="cdx-ghost-time" title={fmtWhen(when)}>{fmtHM(when)}</span>
        <button type="button" className="cdx-ghost-tag" disabled={!sessionId}
          title="A silent message: it did not wake this chat. Open the Inbox."
          onClick={() => sessionId && openSection(sessionId, 'inbox')}>Ghost</button>
        {kind ? <span className={'cdx-ghost-kind ' + kind}>{kind === 'alert' ? 'Alert' : 'Report'}</span> : null}
      </div>
      <div className="cdx-ghost-bubble">{data.body || data.summary || ''}</div>
    </div>
  )
}
