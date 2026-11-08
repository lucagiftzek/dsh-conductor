/**
 * Automation for this chat (header "..." menu, Automation): the automatic
 * level, a scheduled /new, relaying final answers to another chat, this
 * chat's handoff template and recovery. Each part saves on its own; the
 * header summarises what is active in one quiet line.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Switch, Note, useSignal } from '../ui.jsx'
import { toast, toastError } from '../toasts.jsx'
import { statusModel, refreshStatus } from '../store.js'
import { shortId, plural } from '../format.js'

/** The default handoff sections (lib/context/engine.js DEFAULT_HANDOFF_TEMPLATE). */
export const DEFAULT_HANDOFF_TEMPLATE = [
  '# Handoff',
  '## 1. Role and standing orders',
  '- [who you are in this chat; the user\'s standing instructions, preferences and constraints, quoted verbatim where the wording matters]',
  '## 2. Goal and current state',
  '- [the overall goal, and precisely where the work stands now]',
  '## 3. Decisions made',
  '- [decision: reason; alternatives rejected]',
  '## 4. Open items and pending requests',
  '- [everything requested and not yet done; quote the user\'s most recent requests verbatim]',
  '## 5. Files, paths, services, commands',
  '- [exact paths, ids, URLs, commands and their purpose]',
  '## 6. Running work',
  '- [subagents, background jobs, schedules or other chats still working: ids, what they do, where results will land]',
  '## 7. Gotchas',
  '- [what failed and why, traps to avoid, things verified not to work]',
  '## 8. Next step',
  '- [the single next action, in line with the most recent request]',
].join('\n')

/** The automatic level as words, or '' when DSH's own default applies. */
export function levelPhrase(level) {
  if (!level) return ''
  if (level.paused || level.source === 'paused') return 'Auto level paused'
  if (!level.percent) return ''
  return (level.action === 'handoff' ? 'Auto handoff' : 'Auto compact') + ' at ' + level.percent + '%'
}

/** One quiet line of what is automated in this chat, or '' when nothing is. */
export function automationSummary(view) {
  if (!view) return ''
  const parts = []
  const lp = levelPhrase(view.level)
  if (lp) parts.push(lp)
  const a = view.autoNew
  if (a && a.daily) parts.push('/new daily ' + a.daily)
  else if (a && a.everyTurns) parts.push('/new every ' + a.everyTurns + ' turns')
  if (view.relay && view.relay.to) parts.push('answers to ' + (view.relay.label || shortId(view.relay.to)))
  if (typeof view.handoffTemplate === 'string' && view.handoffTemplate.trim()) parts.push('own handoff template')
  const r = view.recovery
  if (r && r.waiting) parts.push('recovery retrying')
  return parts.join(' \u00b7 ')
}

function Part({ title, children, note }) {
  return (
    <section className="cdx-apart">
      <h3 className="cdx-wsub">{title}</h3>
      {note ? <div className="cdx-help">{note}</div> : null}
      {children}
    </section>
  )
}

function useSaver(sessionId, model) {
  const [busy, setBusy] = useState('')
  const save = async (key, fn, okText) => {
    setBusy(key)
    try {
      const r = await fn()
      toast({ message: (r && r.text) || okText, sessionId })
      return r
    } catch (e) {
      toastError('Could not save.', e, sessionId)
      return null
    } finally {
      setBusy('')
      model.refresh().catch(() => {})
    }
  }
  return [busy, save]
}

function LevelPart({ view, api, model, sessionId }) {
  const level = view.level || { percent: 0, action: 'compact', source: 'default', nudge: true }
  const custom = level.source === 'chat'
  const [percent, setPercent] = useState(custom ? level.percent : 50)
  const [action, setAction] = useState(level.action || 'compact')
  const [busy, save] = useSaver(sessionId, model)
  const timer = useRef(null)
  useEffect(() => { if (custom) { setPercent(level.percent); setAction(level.action) } }, [level.percent, level.action, custom])
  useEffect(() => () => clearTimeout(timer.current), [])
  const commit = (p, a) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => save('level', () => api.level({ percent: p, action: a }), 'Automatic level saved.'), 450)
  }
  const inherited = level.source === 'global' ? ((level.action === 'handoff' ? 'Hand off' : 'Compact') + ' at ' + level.percent + '% (all chats)') : 'DSH default (compacts at about 80%)'
  return (
    <Part title="Automatic level" note="When this chat compacts or starts a fresh context by itself.">
      <div className="cdx-radio" role="radiogroup" aria-label="Automatic level">
        <label><input type="radio" name={'cdx-lvl-' + sessionId} checked={!custom} disabled={busy === 'level'}
          onChange={() => save('level', () => api.level({ off: true }), 'Back to the default level.')} />{'Default: ' + inherited}</label>
        <label><input type="radio" name={'cdx-lvl-' + sessionId} checked={custom} disabled={busy === 'level'}
          onChange={() => save('level', () => api.level({ percent, action }), 'Automatic level saved.')} />Custom for this chat</label>
      </div>
      {custom ? (
        <div className="cdx-acustom">
          <div className="cdx-btnrow">
            <input type="range" min={10} max={95} step={5} value={percent} aria-label="Level, percent of the model window" data-level-slider
              onChange={(e) => { const p = Number(e.target.value); setPercent(p); commit(p, action) }} style={{ flex: 1, accentColor: 'var(--clay)' }} />
            <span className="cdx-num" style={{ width: 36, textAlign: 'right' }}>{percent + '%'}</span>
          </div>
          <div className="cdx-radio" role="radiogroup" aria-label="What happens at the level" style={{ flexDirection: 'row', gap: 16 }}>
            <label><input type="radio" name={'cdx-act-' + sessionId} checked={action === 'compact'} onChange={() => { setAction('compact'); commit(percent, 'compact') }} />Compact</label>
            <label><input type="radio" name={'cdx-act-' + sessionId} checked={action === 'handoff'} onChange={() => { setAction('handoff'); commit(percent, 'handoff') }} />Hand off</label>
          </div>
        </div>
      ) : null}
      <div className="cdx-wrow">
        <div className="cdx-grow"><div className="t">Heads-up before the level</div><div className="d">The assistant is told once, so it can finish its step and write things down.</div></div>
        <Switch checked={level.nudge !== false} label="Heads-up before the level" onChange={(v) => save('nudge', () => api.level({ nudge: v }), v ? 'Heads-up on.' : 'Heads-up off.')} />
      </div>
      <div className="cdx-wrow">
        <div className="cdx-grow"><div className="t">Pause for this chat</div><div className="d">DSH's own default applies while paused.</div></div>
        <Switch checked={Boolean(level.paused)} label="Pause the automatic level for this chat" onChange={(v) => save('pause', () => api.level({ paused: v }), v ? 'Paused for this chat.' : 'Resumed.')} />
      </div>
    </Part>
  )
}

function AutoNewPart({ view, api, model, sessionId }) {
  const a = view.autoNew || null
  const mode = a && a.daily ? 'daily' : a && a.everyTurns ? 'turns' : 'off'
  const [pick, setPick] = useState(mode)
  const [time, setTime] = useState((a && a.daily) || '03:00')
  const [turns, setTurns] = useState((a && a.everyTurns) || 40)
  const [busy, save] = useSaver(sessionId, model)
  useEffect(() => { setPick(mode) }, [mode])
  const apply = () => {
    if (pick === 'off') return save('auto', () => api.autoNew({ off: true }), 'Scheduled /new off.')
    if (pick === 'daily') return save('auto', () => api.autoNew({ daily: time }), '/new runs daily at ' + time + '.')
    return save('auto', () => api.autoNew({ everyTurns: Number(turns) }), '/new runs every ' + turns + ' turns.')
  }
  const changed = pick !== mode || (pick === 'daily' && time !== (a && a.daily)) || (pick === 'turns' && Number(turns) !== (a && a.everyTurns))
  return (
    <Part title="Scheduled /new" note={a && a.lastRun ? 'Last run ' + new Date(a.lastRun).toLocaleString() + '.' : 'A fresh context from a handoff, on a schedule.'}>
      <div className="cdx-radio" role="radiogroup" aria-label="Scheduled /new">
        <label><input type="radio" name={'cdx-an-' + sessionId} checked={pick === 'off'} onChange={() => setPick('off')} />Off</label>
        <label><input type="radio" name={'cdx-an-' + sessionId} checked={pick === 'daily'} onChange={() => setPick('daily')} />
          Daily at <input className="cdx-in s" type="time" value={time} aria-label="Time of day" style={{ width: 96, marginLeft: 6 }} onChange={(e) => { setTime(e.target.value); setPick('daily') }} /></label>
        <label><input type="radio" name={'cdx-an-' + sessionId} checked={pick === 'turns'} onChange={() => setPick('turns')} />
          Every <input className="cdx-in s" type="number" min={2} max={1000} value={turns} aria-label="Number of turns" style={{ width: 64, margin: '0 6px' }} onChange={(e) => { setTurns(e.target.value); setPick('turns') }} /> turns</label>
      </div>
      {a && a.pending ? <div className="cdx-help">A /new is waiting for the current turn to end.</div> : null}
      {changed ? <div className="cdx-btnrow"><button type="button" className="cdx-btn s p" data-save-autonew disabled={busy === 'auto'} onClick={apply}>Save</button></div> : null}
    </Part>
  )
}

function RelayPart({ view, api, model, sessionId }) {
  const status = useSignal(statusModel)
  useEffect(() => { if (!status.data) refreshStatus() }, [])
  const rows = useMemo(() => ((status.data && status.data.agents && status.data.agents.rows) || []).filter((r) => r.sessionId !== sessionId), [status.data, sessionId])
  const current = (view.relay && view.relay.to) || ''
  const [busy, save] = useSaver(sessionId, model)
  return (
    <Part title="Relay final answers" note="Each final answer of this chat lands in another chat as a ghost (it does not wake it).">
      <select className="cdx-in" style={{ width: '100%' }} aria-label="Relay final answers to" value={current} disabled={busy === 'relay'} data-relay
        onChange={(e) => save('relay', () => api.relay(e.target.value || null), e.target.value ? 'Final answers now go to that chat.' : 'Relay off.')}>
        <option value="">Off</option>
        {current && !rows.some((r) => r.sessionId === current) ? <option value={current}>{(view.relay && view.relay.label) || shortId(current)}</option> : null}
        {rows.map((r) => <option key={r.sessionId} value={r.sessionId}>{(r.title || '(untitled)') + ' \u00b7 ' + shortId(r.sessionId)}</option>)}
      </select>
    </Part>
  )
}

function TemplatePart({ view, api, model, sessionId }) {
  const own = typeof view.handoffTemplate === 'string' && view.handoffTemplate.trim() ? view.handoffTemplate : ''
  const [custom, setCustom] = useState(Boolean(own))
  const [text, setText] = useState(own)
  const [busy, save] = useSaver(sessionId, model)
  useEffect(() => { setCustom(Boolean(own)); setText(own) }, [own])
  return (
    <Part title="Handoff template" note="The sections the assistant fills in when it hands off (/new).">
      <div className="cdx-radio" role="radiogroup" aria-label="Handoff template">
        <label><input type="radio" name={'cdx-tpl-' + sessionId} checked={!custom} onChange={() => { setCustom(false); if (own) save('tpl', () => api.template(''), 'Back to the default template.') }} />Default</label>
        <label><input type="radio" name={'cdx-tpl-' + sessionId} checked={custom} onChange={() => setCustom(true)} />Custom for this chat</label>
      </div>
      {custom ? (
        <>
          <textarea className="cdx-in" rows={8} value={text} aria-label="Handoff template for this chat" data-template
            placeholder="Markdown sections, for example ## Goal, ## Decisions, ## Next step" onChange={(e) => setText(e.target.value)} />
          <div className="cdx-btnrow">
            <button type="button" className="cdx-btn s p" disabled={busy === 'tpl' || !text.trim() || text === own} onClick={() => save('tpl', () => api.template(text), 'Template saved for this chat.')}>Save template</button>
            <button type="button" className="cdx-btn s g" data-template-default onClick={() => setText(DEFAULT_HANDOFF_TEMPLATE)}>Start from the default</button>
          </div>
        </>
      ) : <pre className="cdx-pre short" aria-label="Default handoff template">{DEFAULT_HANDOFF_TEMPLATE}</pre>}
    </Part>
  )
}

function RecoveryPart({ view, api, model, sessionId }) {
  const r = view.recovery
  const [busy, save] = useSaver(sessionId, model)
  if (!r) return <Part title="Recovery"><div className="cdx-help">Recovery is not available in this build.</div></Part>
  const line = r.conflict ? null : [r.enabled ? 'On' : 'Off', r.attempts ? r.attempts + ' of ' + r.maxAttempts + ' ' + plural(r.maxAttempts, 'attempt') + ' used' : '', r.waiting ? 'waiting to retry' : '', r.fallback ? 'fallback model ' + r.fallback : ''].filter(Boolean).join(' \u00b7 ')
  return (
    <Part title="Recovery" note="Resumes this chat after a failed, cut-off or crashed turn.">
      {r.conflict ? <Note tone="warn">Off because dsh-continue is still installed; the migration replaces it.</Note> : (
        <div className="cdx-wrow">
          <div className="cdx-grow"><div className="t">Recover this chat</div><div className="d" data-recovery-status>{line}</div></div>
          <Switch checked={!r.chatDisabled && r.enabled} label="Recover this chat" disabled={busy === 'rec'}
            onChange={(v) => save('rec', () => api.recovery(v), v ? 'Recovery on for this chat.' : 'Recovery off for this chat.')} />
        </div>
      )}
    </Part>
  )
}

export function AutomationPanel({ sessionId, view, api, model, onBack }) {
  return (
    <div className="cdx-auto" data-automation>
      <div className="cdx-phead">
        <button type="button" className="cdx-link" data-automation-back onClick={onBack}>Back</button>
        <span className="cdx-help" style={{ marginLeft: 'auto' }}>Automation for this chat</span>
      </div>
      <LevelPart view={view} api={api} model={model} sessionId={sessionId} />
      <AutoNewPart view={view} api={api} model={model} sessionId={sessionId} />
      <RelayPart view={view} api={api} model={model} sessionId={sessionId} />
      <TemplatePart view={view} api={api} model={model} sessionId={sessionId} />
      <RecoveryPart view={view} api={api} model={model} sessionId={sessionId} />
    </div>
  )
}
