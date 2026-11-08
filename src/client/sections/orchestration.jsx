/**
 * Agents and tasks section: the dsh-orchestrator UI ported into one
 * accordion section (UX spec A10). Agents (this chat or all, spawn, prompt,
 * fork, open, post, cancel), tasks (live output, follow, copy, cancel, new
 * task form), runners (probe) and providers (status cards).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fmtAgo, fmtClock, shortId, plural, toMs } from '../format.js'
import { Icon, IconButton, Empty, Note, useNow, useSignal, copyText, SectionError } from '../ui.jsx'
import { toast, toastError } from '../toasts.jsx'
import { getJson, post, errorText } from '../api.js'
import { statusModel, refreshStatus, settingsModel } from '../store.js'
import { PostForm } from './inbox.jsx'

const enc = encodeURIComponent
const POLL_MS = 4000


// ── agents ─────────────────────────────────────────────────────────────

function agentDot(row) {
  if (row.running) return 'cdx-dot live pulse'
  if (row.live) return 'cdx-dot ok'
  return 'cdx-dot idle'
}

function SpawnForm({ onDone, sessionId }) {
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [count, setCount] = useState(1)
  const [preset, setPreset] = useState('')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await post('/agents/spawn', { title, prompt, count, preset, cwd })
      const n = ((r && r.created) || []).length
      toast({ message: 'Spawned ' + n + ' ' + plural(n, 'chat') + (prompt.trim() ? ' with a first prompt.' : '.'), sessionId })
      onDone()
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  return (
    <form className="cdx-form" onSubmit={submit} aria-label="Spawn agent" data-spawn-form>
      <div className="cdx-frow">
        <label className="cdx-field"><span>Title (addressable by name)</span>
          <input className="cdx-in" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="research-{i}" /></label>
        <label className="cdx-field" style={{ flex: '0 0 64px' }}><span>Count</span>
          <input className="cdx-in" type="number" min={1} max={8} value={count} onChange={(e) => setCount(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} /></label>
      </div>
      <label className="cdx-field"><span>First prompt</span>
        <textarea className="cdx-in" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What the agent should do. {i} becomes 1 to N when count is above 1." /></label>
      <div className="cdx-frow">
        <label className="cdx-field"><span>Preset (optional)</span><input className="cdx-in" value={preset} onChange={(e) => setPreset(e.target.value)} placeholder="deployment default" /></label>
        <label className="cdx-field"><span>Working directory (optional)</span><input className="cdx-in" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="server default" /></label>
      </div>
      {error ? <Note tone="bad" role="alert">{error}</Note> : null}
      <div className="cdx-btnrow">
        <button type="submit" className="cdx-btn p s" disabled={busy || (!prompt.trim() && !title.trim())}>{busy ? 'Spawning\u2026' : prompt.trim() ? 'Spawn and prompt' : 'Spawn'}</button>
        <button type="button" className="cdx-btn s g" onClick={onDone}>Cancel</button>
      </div>
    </form>
  )
}

function AgentDetail({ row, sessionId, openSession, onPost }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const box = useRef(null)
  const load = useCallback(() => getJson('/agents/' + enc(row.sessionId) + '/transcript?max=12').then((t) => { setData(t); setError(null) }, setError), [row.sessionId])
  useEffect(() => {
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [data])
  const send = async () => {
    const message = text.trim()
    if (!message) return
    setSending(true)
    try {
      await post('/agents/' + enc(row.sessionId) + '/prompt', { message })
      setText('')
      toast({ message: 'Message sent to ' + (row.title || shortId(row.sessionId)) + '.', sessionId })
      load()
      refreshStatus()
    } catch (e) { toastError('Could not send the message.', e, sessionId) } finally { setSending(false) }
  }
  const fork = async () => {
    try {
      const r = await post('/agents/fork', { agent: row.sessionId })
      toast({ message: 'Forked into a new chat.', sessionId, undoLabel: 'Open', undo: r.sessionId ? async () => { openSession(r.sessionId); return 'Opened the fork.' } : null })
      refreshStatus()
    } catch (e) { toastError('Could not fork the chat.', e, sessionId) }
  }
  const messages = (data && data.messages) || []
  return (
    <div className="cdx-detail" onClick={(e) => e.stopPropagation()}>
      {error ? <SectionError what="the transcript" error={error} onRetry={load} /> : null}
      <div ref={box} style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {!data && !error ? <span className="cdx-help">Loading the transcript\u2026</span> : null}
        {data && !messages.length ? <span className="cdx-help">No messages yet.</span> : null}
        {messages.map((m, i) => (
          <div key={i} style={{ borderLeft: '2px solid ' + (m.role === 'user' ? 'var(--line)' : 'var(--c-instr)'), padding: '1px 0 1px 8px' }}>
            <div className="cdx-help" style={{ textTransform: 'uppercase', letterSpacing: '.05em', fontSize: 10 }}>{m.role === 'user' ? 'Prompt' : 'Agent'}</div>
            <div className="cdx-text" style={{ fontSize: 12 }}>{String(m.text || '').slice(0, 4000)}</div>
          </div>
        ))}
      </div>
      <textarea className="cdx-in" rows={2} value={text} onChange={(e) => setText(e.target.value)} aria-label={'Message to ' + (row.title || row.sessionId)}
        placeholder="Message this chat (Ctrl+Enter to send)" onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() } }} />
      <div className="cdx-btnrow">
        <button type="button" className="cdx-btn p s" disabled={sending || !text.trim()} onClick={send}>{sending ? 'Sending\u2026' : 'Send'}</button>
        <button type="button" className="cdx-btn s g" onClick={() => openSession(row.sessionId)}>{Icon.open(13)}Open</button>
        <button type="button" className="cdx-btn s g" onClick={fork}>{Icon.fork(13)}Fork</button>
        <button type="button" className="cdx-btn s g" onClick={() => onPost(row.sessionId)}>{Icon.send(13)}Post silently</button>
      </div>
    </div>
  )
}

function AgentsBlock({ data, sessionId, openSession }) {
  const [scope, setScope] = useState('mine')
  const [spawn, setSpawn] = useState(false)
  const [open, setOpen] = useState(null)
  const [postTo, setPostTo] = useState(null)
  const [busy, setBusy] = useState('')
  const all = (data && data.agents && data.agents.rows) || []
  const rows = useMemo(() => {
    if (scope === 'all' || !sessionId) return all
    const me = all.find((r) => r.sessionId === sessionId)
    const parent = me && me.parentSessionId
    return all.filter((r) => r.sessionId !== sessionId && (r.parentSessionId === sessionId || (parent && r.sessionId === parent) || (parent && r.parentSessionId === parent)))
  }, [all, scope, sessionId])

  const cancel = async (row) => {
    setBusy(row.sessionId)
    try {
      await post('/agents/' + enc(row.sessionId) + '/cancel', {})
      toast({ message: 'Asked ' + (row.title || shortId(row.sessionId)) + ' to stop.', sessionId })
      refreshStatus()
    } catch (e) { toastError('Could not stop the agent.', e, sessionId) } finally { setBusy('') }
  }

  return (
    <div>
      <div className="cdx-sub">
        Agents
        <span className="cdx-spacer" />
        {sessionId ? (
          <span role="group" aria-label="Which chats" style={{ display: 'inline-flex' }}>
            <button type="button" className="cdx-chipbtn" aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>This chat</button>
            <button type="button" className="cdx-chipbtn" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All</button>
          </span>
        ) : null}
        <button type="button" className="cdx-btn s" aria-expanded={spawn} onClick={() => setSpawn(!spawn)}>{Icon.plus(12)}Spawn agent</button>
      </div>
      {data && data.agents && data.agents.degraded ? <Note tone="warn">The session catalog is partly degraded, so only live agents are listed.</Note> : null}
      {spawn ? <SpawnForm sessionId={sessionId} onDone={() => { setSpawn(false); refreshStatus() }} /> : null}
      {postTo ? <PostForm sessionId={sessionId} initialTarget={postTo} onDone={() => setPostTo(null)} /> : null}
      {!rows.length ? (
        <Empty title={scope === 'mine' ? 'No other chats running' : 'No chats'}>
          {scope === 'mine' ? 'Spawn an agent to work on a task in parallel. Subagents and forks of this chat appear here.' : 'Spawn an agent to work on a task in parallel.'}
        </Empty>
      ) : (
        <ul className="cdx-list" aria-label="Agents">
          {rows.slice(0, 60).map((row) => (
            <li key={row.sessionId}>
              <div className={'cdx-row click' + (open === row.sessionId ? ' open' : '')} tabIndex={0} aria-expanded={open === row.sessionId} data-agent={row.sessionId}
                onClick={() => setOpen(open === row.sessionId ? null : row.sessionId)}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(open === row.sessionId ? null : row.sessionId) } }}>
                <span className={agentDot(row)} aria-label={row.running ? 'Working' : row.live ? 'Live' : 'Idle'} role="img" />
                <div className="cdx-main">
                  <div className="cdx-title"><span title={row.sessionId}>{row.title || '(untitled)'}</span>{row.sessionId === sessionId ? <span className="cdx-chip">this chat</span> : null}</div>
                  <div className="cdx-meta"><span>{(row.running ? 'working' : row.live ? 'live' : 'idle') + ' \u00b7 ' + (fmtAgo(row.updatedAt) || 'unknown') + (row.origin === 'subagent' ? ' \u00b7 subagent' : '') + ' \u00b7 ' + shortId(row.sessionId)}</span></div>
                </div>
                <div className="cdx-side">
                  <span className="cdx-acts">
                    <IconButton label={'Open ' + (row.title || 'chat')} onClick={() => openSession(row.sessionId)}>{Icon.open(13)}</IconButton>
                  </span>
                  {row.running ? (
                    <button type="button" className="cdx-btn s d" style={{ marginLeft: 6 }} disabled={busy === row.sessionId} onClick={(e) => { e.stopPropagation(); cancel(row) }}>Cancel</button>
                  ) : null}
                </div>
                {open === row.sessionId ? <AgentDetail row={row} sessionId={sessionId} openSession={openSession} onPost={(id) => { setOpen(null); setPostTo(id) }} /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── tasks ──────────────────────────────────────────────────────────────

const TYPES = ['command', 'scrape', 'http', 'agent']
const STATUS_DOT = { queued: 'cdx-dot idle', running: 'cdx-dot live pulse', completed: 'cdx-dot ok', failed: 'cdx-dot bad', cancelled: 'cdx-dot warn', interrupted: 'cdx-dot warn' }

function TaskOutput({ t, sessionId }) {
  const [out, setOut] = useState(null)
  const [follow, setFollow] = useState(true)
  const ref = useRef(null)
  useEffect(() => {
    let alive = true
    const load = () => getJson('/tasks/' + enc(t.id) + '/output?tail=8000').then((j) => { if (alive) setOut(j) }, () => {})
    load()
    const timer = t.status === 'running' || t.status === 'queued' ? setInterval(load, POLL_MS) : null
    return () => { alive = false; if (timer) clearInterval(timer) }
  }, [t.id, t.status])
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [out, follow])
  const text = (out && out.output) || t.outputPreview || ''
  return (
    <div className="cdx-detail" onClick={(e) => e.stopPropagation()}>
      <div className="cdx-meta" style={{ flexWrap: 'wrap', whiteSpace: 'normal' }}>
        <span>{'status ' + t.status}</span>
        {t.via ? <span>{'via ' + t.via}</span> : null}
        {t.agentSessionId ? <span>{'chat ' + shortId(t.agentSessionId)}</span> : null}
        {t.detail ? <span title={t.detail}>{t.detail}</span> : null}
      </div>
      <pre className="cdx-pre log" ref={ref} data-task-output>{text || '(no output yet)'}</pre>
      <div className="cdx-btnrow">
        <label className="cdx-help" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} style={{ accentColor: 'var(--clay)', margin: 0 }} />Following
        </label>
        <span className="cdx-spacer" />
        <button type="button" className="cdx-btn s g" onClick={async () => { const ok = await copyText(text); toast({ message: ok ? 'Copied the task log.' : 'Copy is not available in this browser.', sessionId }) }}>Copy log</button>
      </div>
    </div>
  )
}

function duration(t, now) {
  const start = toMs(t.startedAt) || toMs(t.createdAt)
  if (!Number.isFinite(start)) return ''
  const end = toMs(t.finishedAt)
  return fmtClock((Number.isFinite(end) ? end : now) - start)
}

function NewTaskForm({ runners, sessionId, commandsAllowed, onDone }) {
  const [type, setType] = useState(commandsAllowed ? 'command' : 'scrape')
  const [f, setF] = useState({ title: '', runner: '', command: '', cwd: '', urls: '', extract: 'text', selector: '', pattern: '', url: '', method: 'GET', body: '', prompt: '', count: 1, forkOf: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const submit = async (e) => {
    e.preventDefault()
    const spec = { type, title: f.title, runner: f.runner || 'auto' }
    if (sessionId) spec.ownerSession = sessionId
    if (type === 'command') { spec.command = f.command; spec.cwd = f.cwd }
    if (type === 'scrape') {
      spec.urls = f.urls.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
      spec.extract = f.extract
      if (f.selector) spec.selector = f.selector
      if (f.pattern) spec.pattern = f.pattern
    }
    if (type === 'http') { spec.url = f.url; spec.method = f.method; if (f.body) spec.body = f.body }
    if (type === 'agent') { spec.prompt = f.prompt; if (f.count > 1) spec.count = Number(f.count); if (f.forkOf.trim()) spec.forkOf = f.forkOf.trim() }
    setBusy(true)
    setError('')
    try {
      const r = await post('/tasks', spec)
      toast({ message: 'Task ' + ((r.task && r.task.id) || '') + ' ' + ((r.task && r.task.status) || 'created') + '.', sessionId })
      onDone()
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  const ready = type === 'command' ? f.command.trim() && commandsAllowed : type === 'scrape' ? f.urls.trim() : type === 'http' ? f.url.trim() : f.prompt.trim()
  return (
    <form className="cdx-form" onSubmit={submit} aria-label="New task" data-task-form>
      <span role="group" aria-label="Task type" style={{ display: 'inline-flex', flexWrap: 'wrap' }}>
        {TYPES.map((tp) => <button key={tp} type="button" className="cdx-chipbtn" aria-pressed={type === tp} onClick={() => setType(tp)}>{tp}</button>)}
      </span>
      <label className="cdx-field"><span>Title (optional)</span><input className="cdx-in" value={f.title} onChange={set('title')} /></label>
      {type === 'command' ? (
        commandsAllowed ? (
          <>
            <label className="cdx-field"><span>Shell command</span><textarea className="cdx-in" rows={2} value={f.command} onChange={set('command')} placeholder="runs on the selected runner" /></label>
            <div className="cdx-frow">
              <label className="cdx-field"><span>Runner</span>
                <select className="cdx-in" style={{ width: '100%' }} value={f.runner} onChange={set('runner')}>
                  <option value="">auto (default)</option>
                  {(runners || []).map((r) => <option key={r.id} value={r.id}>{r.id + ' (' + r.kind + ')' + (r.enabled ? '' : ' off')}</option>)}
                </select></label>
              <label className="cdx-field"><span>Working directory</span><input className="cdx-in" value={f.cwd} onChange={set('cwd')} placeholder="/" /></label>
            </div>
          </>
        ) : <Note tone="warn">Shell command tasks are off by default. Turn them on in Settings, Conductor, Tasks.</Note>
      ) : null}
      {type === 'scrape' ? (
        <>
          <label className="cdx-field"><span>URLs (one per line)</span><textarea className="cdx-in" rows={2} value={f.urls} onChange={set('urls')} /></label>
          <div className="cdx-frow">
            <label className="cdx-field" style={{ flex: '0 0 auto' }}><span>Extract</span>
              <select className="cdx-in" value={f.extract} onChange={set('extract')}>{['text', 'html', 'json'].map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
            <label className="cdx-field"><span>Selector</span><input className="cdx-in" value={f.selector} onChange={set('selector')} placeholder="h1, .price" /></label>
            <label className="cdx-field"><span>Regex</span><input className="cdx-in" value={f.pattern} onChange={set('pattern')} /></label>
          </div>
        </>
      ) : null}
      {type === 'http' ? (
        <>
          <div className="cdx-frow">
            <label className="cdx-field" style={{ flex: '0 0 auto' }}><span>Method</span>
              <select className="cdx-in" value={f.method} onChange={set('method')}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
            <label className="cdx-field"><span>URL</span><input className="cdx-in" value={f.url} onChange={set('url')} placeholder="https://" /></label>
          </div>
          {f.method !== 'GET' && f.method !== 'HEAD' ? <label className="cdx-field"><span>Body (JSON)</span><textarea className="cdx-in" rows={2} value={f.body} onChange={set('body')} /></label> : null}
        </>
      ) : null}
      {type === 'agent' ? (
        <>
          <label className="cdx-field"><span>Prompt</span><textarea className="cdx-in" rows={3} value={f.prompt} onChange={set('prompt')} placeholder="What the agent should do ({i} for fan-out)" /></label>
          <div className="cdx-frow">
            <label className="cdx-field" style={{ flex: '0 0 64px' }}><span>Count</span><input className="cdx-in" type="number" min={1} max={8} value={f.count} onChange={set('count')} /></label>
            <label className="cdx-field"><span>Fork from (optional)</span><input className="cdx-in" value={f.forkOf} onChange={set('forkOf')} placeholder="chat id, prefix or title" /></label>
          </div>
        </>
      ) : null}
      {error ? <Note tone="bad" role="alert">{error}</Note> : null}
      <div className="cdx-btnrow">
        <button type="submit" className="cdx-btn p s" disabled={busy || !ready}>{busy ? 'Creating\u2026' : 'Create task'}</button>
        <button type="button" className="cdx-btn s g" onClick={onDone}>Cancel</button>
      </div>
    </form>
  )
}

function TasksBlock({ data, sessionId }) {
  const settings = useSignal(settingsModel)
  const [scope, setScope] = useState('mine')
  const [type, setType] = useState('')
  const [open, setOpen] = useState(null)
  const [form, setForm] = useState(false)
  const all = (data && data.tasks && data.tasks.rows) || []
  const rows = all.filter((t) => (scope === 'all' || !sessionId || t.ownerSession === sessionId || t.agentSessionId === sessionId) && (!type || t.type === type))
  const anyRunning = rows.some((t) => t.status === 'running')
  const now = useNow(1000, anyRunning)
  const s = settings.data && settings.data.settings
  const commandsAllowed = Boolean(s && s.tasks && s.tasks.allowCommandTasks)

  const cancel = async (t) => {
    try {
      await post('/tasks/' + enc(t.id) + '/cancel', {})
      toast({ message: 'Cancelled task ' + t.id + '.', sessionId })
      refreshStatus()
    } catch (e) { toastError('Could not cancel the task.', e, sessionId) }
  }
  return (
    <div>
      <div className="cdx-sub">
        Tasks
        <span className="cdx-spacer" />
        {sessionId ? (
          <span role="group" aria-label="Which tasks" style={{ display: 'inline-flex' }}>
            <button type="button" className="cdx-chipbtn" aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>This chat</button>
            <button type="button" className="cdx-chipbtn" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All</button>
          </span>
        ) : null}
        <button type="button" className="cdx-btn s" aria-expanded={form} onClick={() => setForm(!form)}>{Icon.plus(12)}New task</button>
      </div>
      {s && !commandsAllowed ? <div className="cdx-help" style={{ padding: '0 12px 6px' }}>Shell command tasks are off by default (Settings, Conductor, Tasks). Scrape, HTTP and agent tasks work.</div> : null}
      {form ? <NewTaskForm runners={(data && data.runners) || []} sessionId={scope === 'mine' ? sessionId : null} commandsAllowed={commandsAllowed} onDone={() => { setForm(false); refreshStatus() }} /> : null}
      {all.length ? (
        <div className="cdx-tools" style={{ position: 'static', minHeight: 30 }}>
          {['', ...TYPES].map((tp) => <button key={tp || 'all'} type="button" className="cdx-chipbtn" aria-pressed={type === tp} onClick={() => setType(tp)}>{tp || 'all'}</button>)}
        </div>
      ) : null}
      {!rows.length ? <Empty title="No background tasks">Long running commands started by agents show live output here.</Empty> : (
        <ul className="cdx-list" aria-label="Tasks">
          {rows.slice(0, 40).map((t) => (
            <li key={t.id}>
              <div className={'cdx-row click' + (open === t.id ? ' open' : '')} tabIndex={0} aria-expanded={open === t.id} data-task={t.id}
                onClick={() => setOpen(open === t.id ? null : t.id)}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(open === t.id ? null : t.id) } }}>
                <span className={STATUS_DOT[t.status] || 'cdx-dot idle'} role="img" aria-label={t.status} />
                <div className="cdx-main">
                  <div className="cdx-title"><span title={t.title}>{t.title || t.id}</span></div>
                  <div className="cdx-meta"><span className="cdx-chip">{t.type}</span>{t.runner ? <span className="cdx-chip">{'@' + t.runner}</span> : null}<span>{t.status === 'running' ? 'running' : t.status + ' ' + fmtAgo(t.finishedAt || t.createdAt)}</span></div>
                </div>
                <div className="cdx-side">
                  <span className="cdx-num" aria-hidden="true">{duration(t, now)}</span>
                  {t.status === 'running' || t.status === 'queued' ? <button type="button" className="cdx-btn s d" style={{ marginLeft: 6 }} onClick={(e) => { e.stopPropagation(); cancel(t) }}>Cancel</button> : null}
                </div>
                {open === t.id ? <TaskOutput t={t} sessionId={sessionId} /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── runners and providers ──────────────────────────────────────────────

function RunnersBlock({ sessionId }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState('')
  const load = useCallback(() => getJson('/runners').then((j) => { setRows(j.rows || []); setError(null) }, setError), [])
  useEffect(() => { load() }, [load])
  const probe = async (id) => {
    setBusy(id)
    try { await post('/runners/probe', { runner: id }) } catch (e) { toastError('Probe failed.', e, sessionId) }
    await load()
    setBusy('')
  }
  return (
    <div>
      <div className="cdx-sub">Runners</div>
      {error ? <SectionError what="runners" error={error} onRetry={load} /> : null}
      {rows && !rows.length ? <Empty title="No runners">Runners are declared in Settings, Conductor.</Empty> : null}
      {rows && rows.length ? (
        <ul className="cdx-list" aria-label="Runners">
          {rows.map((r) => (
            <li key={r.id} className="cdx-row">
              <span className={'cdx-dot ' + (r.probe ? (r.probe.ok ? 'ok' : 'bad') : 'idle')} role="img" aria-label={r.probe ? (r.probe.ok ? 'Reachable' : 'Unreachable') : 'Not probed'} />
              <div className="cdx-main">
                <div className="cdx-title"><span>{r.id}</span><span className="cdx-chip">{r.kind}</span>{r.enabled === false ? <span className="cdx-chip warn">off</span> : null}</div>
                <div className="cdx-meta"><span>{r.probe ? (r.probe.ok ? 'reachable \u00b7 ' + r.probe.ms + ' ms' : String(r.probe.detail || 'unreachable').slice(0, 80)) : (r.label || 'not probed yet')}</span></div>
              </div>
              <button type="button" className="cdx-btn s" disabled={busy === r.id} onClick={() => probe(r.id)}>{busy === r.id ? 'Probing\u2026' : 'Probe'}</button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function ProvidersBlock() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const load = useCallback((refresh) => getJson('/providers' + (refresh ? '?refresh=1' : '')).then((j) => { setRows(j.rows || []); setError(null) }, setError), [])
  useEffect(() => { load() }, [load])
  if (rows && !rows.length && !error) return null
  return (
    <div>
      <div className="cdx-sub">Providers<span className="cdx-spacer" /><button type="button" className="cdx-btn s g" onClick={() => load(true)}>Refresh</button></div>
      {error ? <SectionError what="providers" error={error} onRetry={() => load(true)} /> : null}
      {rows ? (
        <ul className="cdx-list" aria-label="Providers">
          {rows.map((p) => (
            <li key={p.id} className="cdx-row" style={{ gridTemplateColumns: '18px minmax(0,1fr)' }}>
              <span className={'cdx-dot ' + (p.ok ? 'ok' : 'bad')} role="img" aria-label={p.ok ? 'Up' : 'Down'} />
              <div className="cdx-main">
                <div className="cdx-title"><span>{p.label || p.id}</span><span className="cdx-chip">{p.kind}</span></div>
                <div className="cdx-meta" style={{ whiteSpace: 'normal' }}><span>{[p.headline, p.queue ? 'queue ' + p.queue.running + ' running, ' + p.queue.pending + ' pending' : '', p.detail].filter(Boolean).join(' \u00b7 ')}</span></div>
                {p.kind === 'http' && p.ok && p.fields ? (
                  <div className="cdx-meta" style={{ whiteSpace: 'normal', flexWrap: 'wrap' }}>{Object.entries(p.fields).slice(0, 8).map(([k, v]) => <span key={k}>{k + ': ' + String(v)}</span>)}</div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** What is running now: working agents and running or queued tasks. */
export function runningNow(data) {
  const agents = ((data && data.agents && data.agents.rows) || []).filter((r) => r.running)
  const tasks = ((data && data.tasks && data.tasks.rows) || []).filter((t) => t.status === 'running' || t.status === 'queued')
  return { agents, tasks }
}

export function OrchestrationSection({ sessionId, openSession }) {
  const status = useSignal(statusModel)
  const [all, setAll] = useState(false)
  const [more, setMore] = useState(false)
  useEffect(() => { refreshStatus() }, [])
  if (status.status === 'error' && !status.data) return <SectionError what="agents and tasks" error={status.error} onRetry={refreshStatus} />
  if (!status.data) return <div className="cdx-skel" aria-busy="true" />
  const now = runningNow(status.data)
  const nothing = !now.agents.length && !now.tasks.length
  return (
    <div>
      {all ? (
        <>
          <AgentsBlock data={status.data} sessionId={sessionId} openSession={openSession} />
          <TasksBlock data={status.data} sessionId={sessionId} />
        </>
      ) : (
        <RunningNow data={status.data} now={now} sessionId={sessionId} openSession={openSession} nothing={nothing} />
      )}
      {more ? (
        <>
          <RunnersBlock sessionId={sessionId} />
          <ProvidersBlock />
        </>
      ) : null}
      <div className="cdx-panelfoot">
        <button type="button" className="cdx-link" data-agents-all aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Running now only' : 'Show all agents and tasks'}</button>
        <button type="button" className="cdx-link" data-agents-more aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Hide runners' : 'More: runners and providers'}</button>
      </div>
    </div>
  )
}

function RunningNow({ data, now, sessionId, openSession, nothing }) {
  const [spawn, setSpawn] = useState(false)
  const nowMs = useNow(1000, now.tasks.some((t) => t.status === 'running'))
  const cancelAgent = async (row) => {
    try { await post('/agents/' + enc(row.sessionId) + '/cancel', {}); toast({ message: 'Asked ' + (row.title || shortId(row.sessionId)) + ' to stop.', sessionId }); refreshStatus() } catch (e) { toastError('Could not stop the agent.', e, sessionId) }
  }
  const cancelTask = async (t) => {
    try { await post('/tasks/' + enc(t.id) + '/cancel', {}); toast({ message: 'Cancelled task ' + t.id + '.', sessionId }); refreshStatus() } catch (e) { toastError('Could not cancel the task.', e, sessionId) }
  }
  return (
    <div>
      <div className="cdx-phead">
        <span className="cdx-help">Running now</span>
        <span className="cdx-spacer" />
        <button type="button" className="cdx-link" aria-expanded={spawn} onClick={() => setSpawn(!spawn)}>Spawn agent</button>
      </div>
      {spawn ? <SpawnForm sessionId={sessionId} onDone={() => { setSpawn(false); refreshStatus() }} /> : null}
      {nothing ? <Empty title="Nothing running">Agents and background tasks appear here while they work.</Empty> : (
        <ul className="cdx-list plain" aria-label="Running now">
          {now.agents.map((row) => (
            <li key={row.sessionId} className="cdx-row" data-agent={row.sessionId}>
              <span className="cdx-dot live pulse" role="img" aria-label="Working" />
              <div className="cdx-main">
                <div className="cdx-title"><span>{row.title || '(untitled)'}</span></div>
                <div className="cdx-meta"><span>{'agent \u00b7 ' + (fmtAgo(row.updatedAt) || 'working')}</span></div>
              </div>
              <div className="cdx-side">
                <IconButton label={'Open ' + (row.title || 'chat')} onClick={() => openSession(row.sessionId)}>{Icon.open(13)}</IconButton>
                <button type="button" className="cdx-btn s d" onClick={() => cancelAgent(row)}>Cancel</button>
              </div>
            </li>
          ))}
          {now.tasks.map((t) => (
            <li key={t.id} className="cdx-row" data-task={t.id}>
              <span className={STATUS_DOT[t.status] || 'cdx-dot idle'} role="img" aria-label={t.status} />
              <div className="cdx-main">
                <div className="cdx-title"><span>{t.title || t.id}</span></div>
                <div className="cdx-meta"><span>{t.type + ' task \u00b7 ' + t.status}</span></div>
              </div>
              <div className="cdx-side">
                <span className="cdx-num" aria-hidden="true">{duration(t, nowMs)}</span>
                <button type="button" className="cdx-btn s d" onClick={() => cancelTask(t)}>Cancel</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

