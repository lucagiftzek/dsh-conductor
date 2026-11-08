/**
 * The Conductor section of the DSH Settings page (slot settings.section):
 * modules, model tools and permissions, context and posts options next to
 * the orchestrator settings (agents, tasks, runners, providers) and the
 * machine API secret. Saved through PUT /settings (the host re-validates).
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getJson, mutate, post, errorText, API } from './api.js'
import { MODULES, TOOLS, MODEL_MAY, RECOVERY_FIELDS, buildSettingsPatch, setPath, getPath } from './settings-model.js'
import { DEFAULT_HANDOFF_TEMPLATE } from './sections/automation.jsx'
import { Switch, Note, copyText } from './ui.jsx'
import { ensureStyles } from './styles.js'
import { settingsModel, setupRerun } from './store.js'

const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c)

/**
 * Keep the sticky Save bar flush with the bottom edge of whatever scrolls the
 * settings page, painted with that surface's own background. Chrome insets a
 * sticky element by its scroller's padding, so without this the content
 * scrolling through that padding shows below the bar. Re-measured on resize
 * and on theme changes (the body attributes).
 */
export function useFlushStickyBar(ref, ready) {
  useLayoutEffect(() => {
    const bar = ref.current
    if (!bar || typeof window === 'undefined' || typeof getComputedStyle !== 'function') return undefined
    let raf = 0
    const measure = () => {
      raf = 0
      let el = bar.parentElement
      let scroller = null
      while (el && el !== document.documentElement) {
        const cs = getComputedStyle(el)
        if (!scroller && /(auto|scroll|overlay)/.test(cs.overflowY)) scroller = el
        if (scroller) break
        el = el.parentElement
      }
      const pad = scroller ? parseFloat(getComputedStyle(scroller).paddingBottom) || 0 : 0
      bar.style.bottom = pad ? -pad + 'px' : '0px'
      bar.style.paddingBottom = Math.max(10, pad) + 'px'
      bar.style.marginBottom = pad ? -pad + 'px' : ''
      let bg = ''
      for (let p = bar.parentElement; p; p = p.parentElement) {
        const c = getComputedStyle(p).backgroundColor
        if (!transparent(c)) { bg = c; break }
      }
      if (bg) bar.style.backgroundColor = bg
    }
    const schedule = () => { if (!raf) raf = (window.requestAnimationFrame || setTimeout)(measure) }
    measure()
    window.addEventListener('resize', schedule)
    let mo = null
    if (typeof MutationObserver === 'function' && document.body) {
      mo = new MutationObserver(schedule)
      mo.observe(document.body, { attributes: true })
      mo.observe(document.documentElement, { attributes: true })
    }
    return () => {
      window.removeEventListener('resize', schedule)
      if (mo) mo.disconnect()
      if (raf && window.cancelAnimationFrame) window.cancelAnimationFrame(raf)
    }
  }, [ref, ready])
}

function Row({ title, desc, children }) {
  return (
    <div className="cdx-srow">
      <div><div className="t">{title}</div>{desc ? <div className="d">{desc}</div> : null}</div>
      <div>{children}</div>
    </div>
  )
}

function Group({ title, children, note }) {
  return (
    <section className="cdx-sgroup">
      <h4>{title}</h4>
      {note || null}
      {children}
    </section>
  )
}

export function SettingsSection() {
  useEffect(() => { ensureStyles() }, [])
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null) // { tone, text }
  const [loadError, setLoadError] = useState(null)
  const [secret, setSecret] = useState('')
  const barRef = useRef(null)
  useFlushStickyBar(barRef, Boolean(form))

  const load = useCallback(async () => {
    try {
      const j = await getJson('/settings')
      setData(j)
      setForm(JSON.parse(JSON.stringify(j.settings)))
      setLoadError(null)
      settingsModel.set({ status: 'ready', data: j, error: null })
    } catch (e) { setLoadError(e) }
  }, [])
  useEffect(() => { load() }, [load])

  if (loadError && !form) {
    return <div className="cdx-set"><Note tone="bad" role="alert" actions={<button type="button" className="cdx-btn s" onClick={load}>Retry</button>}>
      {'Couldn\u2019t load the Conductor settings. The host half must be mounted (restart dsh-web after installing). ' + errorText(loadError)}
    </Note></div>
  }
  if (!form) return <div className="cdx-set"><div className="cdx-skel" aria-busy="true" /><div className="cdx-skel" /></div>

  const set = (path, value) => setForm((f) => setPath(f, path, value))
  const get = (path) => getPath(form, path)
  const sw = (path, label) => <Switch checked={Boolean(get(path))} label={label} onChange={(v) => set(path, v)} />
  const num = (path, opts = {}) => (
    <input className="cdx-in n" type="number" min={opts.min} max={opts.max} step={opts.step} aria-label={opts.label}
      value={opts.scale ? Math.round(((Number(get(path)) || 0) / opts.scale) * 10) / 10 : (get(path) ?? '')}
      onChange={(e) => { const n = Number(e.target.value); set(path, Number.isFinite(n) ? (opts.scale ? Math.round(n * opts.scale) : n) : 0) }} />
  )
  const text = (path, opts = {}) => (
    <input className="cdx-in" aria-label={opts.label} placeholder={opts.placeholder} value={String(get(path) ?? '')} onChange={(e) => set(path, e.target.value)} />
  )

  const save = async () => {
    setBusy(true)
    setStatus(null)
    try {
      await mutate('PUT', '/settings', buildSettingsPatch(form))
      setStatus({ tone: 'ok', text: 'Settings saved. They apply at once; tool switches reach new turns.' })
      await load()
    } catch (e) { setStatus({ tone: 'bad', text: 'Save failed: ' + errorText(e) }) } finally { setBusy(false) }
  }
  const saveSecret = async (clear) => {
    setBusy(true)
    try {
      await post('/secret', clear ? { clear: true } : { secret: secret.trim() })
      setSecret('')
      setStatus({ tone: 'ok', text: clear ? 'Machine API secret cleared: the machine API is closed.' : 'Machine API secret saved.' })
      await load()
    } catch (e) { setStatus({ tone: 'bad', text: 'Secret not saved: ' + errorText(e) }) } finally { setBusy(false) }
  }

  const runners = form.runners || []
  const providers = form.providers || []
  const api = form.api || {}
  const armed = Boolean(api.secretConfigured || (data && data.envSecretPresent))
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3080'
  const curl = 'curl -sS -X POST ' + origin + API + '/remote/post \\\n  -H "content-type: application/json" \\\n  -H "x-conductor-secret: $CONDUCTOR_SECRET" \\\n  -d \'{"to":"<chat id or title>","text":"build finished","kind":"report"}\''

  return (
    <div className="cdx-set" data-conductor-settings>
      <Note>Conductor: context tools (/new, /clear, /drop, pins, versions), silent posts between chats, and the agents and tasks orchestrator. Everything below is deployment state, saved on the host.</Note>

      <Group title="General">
        <Row title="Plugin enabled" desc="Master switch for the host half.">{sw(['enabled'], 'Plugin enabled')}</Row>
        <Row title="Mirror tasks into Background Tasks" desc="Show Conductor tasks in the DSH jobs list too.">{sw(['mirrorJobs'], 'Mirror tasks')}</Row>
        <Row title="Require the harness cookie on UI calls" desc="Keep on unless a proxy strips cookies.">{sw(['requireHarnessCookie'], 'Require harness cookie')}</Row>
        <Row title="Trusted hosts" desc="Comma separated host names allowed to call the UI API.">
          <input className="cdx-in" aria-label="Trusted hosts" value={(form.trustedHosts || []).join(', ')}
            onChange={(e) => set(['trustedHosts'], e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
        </Row>
      </Group>

      <Group title="Modules">
        {MODULES.map(([k, t, d]) => <Row key={k} title={t} desc={d}>{sw(['modules', k], t)}</Row>)}
      </Group>

      <Group title="Model tools">
        {TOOLS.map(([k, t, d]) => <Row key={k} title={t} desc={d}>{sw(['tools', k], t)}</Row>)}
      </Group>

      <Group title="The model may" note={<div className="cdx-help" style={{ margin: '0 0 4px' }}>What the assistant may do through its tools. You can always do all of it yourself.</div>}>
        {MODEL_MAY.map(([k, t]) => <Row key={k} title={t}>{sw(['modelMay', k], t)}</Row>)}
      </Group>

      <Group title="Context">
        <Row title="Handoff folder" desc="Where /new writes its handoff files. Empty: the plugin state folder.">{text(['handoffDir'], { label: 'Handoff folder', placeholder: 'default' })}</Row>
        <Row title="Reset timeout" desc="Give up on /new, /clear or /force-compact after this many minutes (1 to 60).">{num(['resetTimeoutMs'], { min: 1, max: 60, scale: 60000, label: 'Reset timeout in minutes' })}</Row>
      </Group>

      <Group title="Automatic level" note={<div className="cdx-help" style={{ margin: '0 0 4px' }}>For every chat; a chat can set its own in Conductor, Automation.</div>}>
        <Row title="Level (percent of the model window)" desc="0 keeps DSH's own default (about 80%). Otherwise 10 to 95.">{num(['autoCompact', 'percent'], { min: 0, max: 95, label: 'Automatic level percent' })}</Row>
        <Row title="At the level" desc="Compact summarises in place; Hand off starts a fresh context from a handoff.">
          <select className="cdx-in" style={{ width: 160 }} aria-label="Action at the level" value={get(['autoCompact', 'action']) || 'compact'} onChange={(e) => set(['autoCompact', 'action'], e.target.value)}>
            <option value="compact">Compact</option><option value="handoff">Hand off</option>
          </select>
        </Row>
        <Row title="Heads-up before the level" desc="The assistant is told once, shortly before.">{sw(['autoCompact', 'nudge'], 'Heads-up before the level')}</Row>
      </Group>

      <Group title="Recovery">
        {RECOVERY_FIELDS.map(([k, t, d, kind]) => (
          <Row key={k} title={t} desc={d}>
            {kind === 'bool' ? sw(['recovery', k], t)
              : kind === 'sec' ? num(['recovery', k], { min: 0, scale: 1000, step: 0.1, label: t })
                : kind === 'num' ? num(['recovery', k], { min: 0, label: t })
                  : kind === 'overflow' ? (
                    <select className="cdx-in" style={{ width: 160 }} aria-label={t} value={get(['recovery', 'overflow']) || 'handoff'} onChange={(e) => set(['recovery', 'overflow'], e.target.value)}>
                      <option value="handoff">Hand off</option><option value="stop">Stop</option>
                    </select>
                  ) : text(['recovery', k], { label: t, placeholder: 'default' })}
          </Row>
        ))}
        <Row title="Fallback model" desc="Provider and model id as in DSH's model list, for example deepseek and deepseek-chat. Empty: no fallback.">
          <span className="cdx-btnrow" style={{ flexWrap: 'nowrap' }}>
            <input className="cdx-in" style={{ width: 110 }} aria-label="Fallback provider" placeholder="provider" value={String(get(['recovery', 'fallbackProvider']) || '')} onChange={(e) => set(['recovery', 'fallbackProvider'], e.target.value)} />
            <input className="cdx-in" style={{ width: 140 }} aria-label="Fallback model" placeholder="model" value={String(get(['recovery', 'fallbackModel']) || '')} onChange={(e) => set(['recovery', 'fallbackModel'], e.target.value)} />
          </span>
        </Row>
      </Group>

      <Group title="Handoff template" note={<div className="cdx-help" style={{ margin: '0 0 4px' }}>The sections every /new handoff fills in. Empty: the default eight sections. A chat can set its own.</div>}>
        <textarea className="cdx-in" rows={8} aria-label="Handoff template for all chats" value={String(get(['handoffTemplate']) || '')} placeholder={DEFAULT_HANDOFF_TEMPLATE} onChange={(e) => set(['handoffTemplate'], e.target.value)} />
        <div className="cdx-btnrow" style={{ marginTop: 6 }}>
          <button type="button" className="cdx-btn s g" onClick={() => set(['handoffTemplate'], DEFAULT_HANDOFF_TEMPLATE)}>Start from the default</button>
          <button type="button" className="cdx-btn s g" onClick={() => set(['handoffTemplate'], '')}>Use the default</button>
        </div>
      </Group>

      <Group title="Silent posts">
        <Row title="Maximum characters inline" desc="Longer posts are saved to a file and the message carries the first part and the path.">{num(['posts', 'maxChars'], { min: 500, max: 100000, label: 'Maximum characters' })}</Row>
        <Row title="Show a row in the target chat" desc="A command style row so the person reading that chat sees the post.">{sw(['posts', 'chatRow'], 'Show a row in the target chat')}</Row>
      </Group>

      <Group title="Agents">
        <Row title="Default preset" desc="Empty: the deployment default.">{text(['agents', 'defaultPreset'], { label: 'Default preset' })}</Row>
        <Row title="Default working directory" desc="Empty: the server default.">{text(['agents', 'defaultCwd'], { label: 'Default working directory' })}</Row>
        <Row title="Spawn fan-out cap">{num(['agents', 'spawnMax'], { min: 1, label: 'Spawn cap' })}</Row>
        <Row title="Catalog rows">{num(['agents', 'catalogMax'], { min: 1, label: 'Catalog rows' })}</Row>
        <Row title="Transcript messages per read">{num(['agents', 'transcriptMax'], { min: 5, label: 'Transcript messages' })}</Row>
      </Group>

      <Group title="Tasks">
        <Row title="Allow shell command tasks" desc="Off by default: anything that can create a task could run commands on this host.">{sw(['tasks', 'allowCommandTasks'], 'Allow shell command tasks')}</Row>
        <Row title="Allow remote runners" desc="Off by default: ssh and http runners execute on other machines.">{sw(['tasks', 'allowRemoteRunners'], 'Allow remote runners')}</Row>
        <Row title="Concurrent tasks">{num(['tasks', 'maxConcurrent'], { min: 1, label: 'Concurrent tasks' })}</Row>
        <Row title="Finished tasks kept">{num(['tasks', 'historyKeep'], { min: 1, label: 'Finished tasks kept' })}</Row>
        <Row title="Command timeout (seconds)">{num(['tasks', 'commandTimeoutMs'], { min: 1, scale: 1000, label: 'Command timeout' })}</Row>
        <Row title="Scrape timeout (seconds)">{num(['tasks', 'scrapeTimeoutMs'], { min: 1, scale: 1000, label: 'Scrape timeout' })}</Row>
        <Row title="HTTP timeout (seconds)">{num(['tasks', 'httpTimeoutMs'], { min: 1, scale: 1000, label: 'HTTP timeout' })}</Row>
        <Row title="Scrape URL limit">{num(['tasks', 'scrapeMaxUrls'], { min: 1, max: 64, label: 'Scrape URL limit' })}</Row>
        <Row title="Default runner">{text(['tasks', 'defaultRunner'], { label: 'Default runner' })}</Row>
      </Group>

      <Group title="Runners">
        {runners.map((r, i) => (
          <div key={i} className="cdx-card">
            <div className="cdx-frow">
              <label className="cdx-field"><span>Id</span><input className="cdx-in" value={r.id || ''} onChange={(e) => set(['runners', i, 'id'], e.target.value)} /></label>
              <label className="cdx-field"><span>Label</span><input className="cdx-in" value={r.label || ''} onChange={(e) => set(['runners', i, 'label'], e.target.value)} /></label>
              <label className="cdx-field" style={{ flex: '0 0 auto' }}><span>Kind</span>
                <select className="cdx-in" value={r.kind} onChange={(e) => set(['runners', i, 'kind'], e.target.value)}>{['local', 'ssh', 'http'].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
            </div>
            {r.kind === 'ssh' ? <div className="cdx-frow" style={{ marginTop: 6 }}>
              <label className="cdx-field"><span>ssh target</span><input className="cdx-in" value={(r.ssh && r.ssh.target) || ''} onChange={(e) => set(['runners', i, 'ssh', 'target'], e.target.value)} placeholder="alias or user@host" /></label>
              <label className="cdx-field"><span>ssh binary</span><input className="cdx-in" value={(r.ssh && r.ssh.bin) || ''} onChange={(e) => set(['runners', i, 'ssh', 'bin'], e.target.value)} placeholder="ssh" /></label>
            </div> : null}
            {r.kind === 'http' ? <div className="cdx-frow" style={{ marginTop: 6 }}>
              <label className="cdx-field"><span>URL</span><input className="cdx-in" value={(r.http && r.http.url) || ''} onChange={(e) => set(['runners', i, 'http', 'url'], e.target.value)} placeholder="https://other-host/dsh-conductor/api/remote/run" /></label>
              <label className="cdx-field"><span>Secret env var</span><input className="cdx-in" value={(r.http && r.http.secretEnv) || ''} onChange={(e) => set(['runners', i, 'http', 'secretEnv'], e.target.value)} /></label>
            </div> : null}
            <div className="cdx-btnrow" style={{ marginTop: 8 }}>
              <Switch checked={r.enabled !== false} label={'Runner ' + r.id + ' enabled'} onChange={(v) => set(['runners', i, 'enabled'], v)} /><span className="cdx-help">enabled</span>
              <span className="cdx-spacer" />
              <button type="button" className="cdx-btn s d" onClick={() => set(['runners'], runners.filter((_, j) => j !== i))}>Remove runner</button>
            </div>
          </div>
        ))}
        <button type="button" className="cdx-btn s" onClick={() => set(['runners'], [...runners, { id: 'runner-' + (runners.length + 1), label: '', kind: 'local', enabled: true }])}>Add runner</button>
      </Group>

      <Group title="Providers">
        {providers.map((p, i) => (
          <div key={i} className="cdx-card">
            <div className="cdx-frow">
              <label className="cdx-field"><span>Id</span><input className="cdx-in" value={p.id || ''} onChange={(e) => set(['providers', i, 'id'], e.target.value)} /></label>
              <label className="cdx-field"><span>Label</span><input className="cdx-in" value={p.label || ''} onChange={(e) => set(['providers', i, 'label'], e.target.value)} /></label>
              <label className="cdx-field" style={{ flex: '0 0 auto' }}><span>Kind</span>
                <select className="cdx-in" value={p.kind} onChange={(e) => set(['providers', i, 'kind'], e.target.value)}>{['http', 'hpc'].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
            </div>
            <div className="cdx-frow" style={{ marginTop: 6 }}>
              <label className="cdx-field"><span>URL</span><input className="cdx-in" value={p.url || ''} onChange={(e) => set(['providers', i, 'url'], e.target.value)} placeholder={p.kind === 'hpc' ? 'http://host/dsh-hpc/api' : 'https://status-endpoint/json'} /></label>
              {p.kind === 'http' ? <label className="cdx-field"><span>Secret env var</span><input className="cdx-in" value={p.secretEnv || ''} onChange={(e) => set(['providers', i, 'secretEnv'], e.target.value)} /></label> : null}
            </div>
            <div className="cdx-btnrow" style={{ marginTop: 8 }}>
              <Switch checked={p.enabled !== false} label={'Provider ' + p.id + ' enabled'} onChange={(v) => set(['providers', i, 'enabled'], v)} /><span className="cdx-help">enabled</span>
              <span className="cdx-spacer" />
              <button type="button" className="cdx-btn s d" onClick={() => set(['providers'], providers.filter((_, j) => j !== i))}>Remove provider</button>
            </div>
          </div>
        ))}
        <button type="button" className="cdx-btn s" onClick={() => set(['providers'], [...providers, { id: 'provider-' + (providers.length + 1), label: '', kind: 'http', url: '', enabled: true, pollSeconds: 60 }])}>Add provider</button>
      </Group>

      <Group title="Machine API">
        <Note tone={armed ? 'ok' : 'warn'}>{armed
          ? 'The machine API is armed. Anything that can reach this host and present the secret can post to chats, prompt them, spawn agents and run tasks.'
          : 'The machine API fails closed: no secret is configured. Set one here or set DSH_CONDUCTOR_SECRET on the host.'}</Note>
        <Row title={api.secretConfigured ? 'Rotate the secret' : 'Set a secret'} desc={api.secretFingerprint ? 'Stored fingerprint ' + api.secretFingerprint + (data && data.envSecretPresent ? ' (an environment secret is present and wins)' : '') : 'At least 16 characters.'}>
          <span className="cdx-btnrow">
            <input className="cdx-in" type="password" autoComplete="new-password" aria-label="Machine API secret" style={{ width: 180 }} value={secret} onChange={(e) => setSecret(e.target.value)} />
            <button type="button" className="cdx-btn s" disabled={busy || secret.trim().length < 16} onClick={() => saveSecret(false)}>Save secret</button>
            {api.secretConfigured ? <button type="button" className="cdx-btn s d" disabled={busy} onClick={() => saveSecret(true)}>Clear</button> : null}
          </span>
        </Row>
        <div className="cdx-help" style={{ margin: '8px 0 4px' }}>Post silently into a chat from a script:</div>
        <pre className="cdx-pre log">{curl}</pre>
        <button type="button" className="cdx-btn s g" style={{ marginTop: 6 }} onClick={() => copyText(curl)}>Copy example</button>
      </Group>

      <Group title="Setup guide">
        <Row title="Run setup guide again" desc="Opens the short guided setup in the Conductor tab of the next chat you open it in.">
          <button type="button" className="cdx-btn s" data-rerun-setup onClick={() => { setupRerun.set(true); setStatus({ tone: 'ok', text: 'The setup guide opens in the Conductor tab.' }) }}>Run setup guide</button>
        </Row>
      </Group>

      <div className="cdx-sbar" ref={barRef}>
        <button type="button" className="cdx-btn p" disabled={busy} onClick={save} data-save-settings>{busy ? 'Saving\u2026' : 'Save settings'}</button>
        <button type="button" className="cdx-btn" disabled={busy} onClick={load}>Revert</button>
        {status ? <span role={status.tone === 'bad' ? 'alert' : 'status'} style={{ fontSize: 12, color: status.tone === 'bad' ? 'var(--bad)' : 'var(--ok)' }}>{status.text}</span> : null}
      </div>
    </div>
  )
}
