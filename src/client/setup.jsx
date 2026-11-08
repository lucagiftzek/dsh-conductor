/**
 * First-run setup guide, shown in the Conductor tab instead of the sub-tabs
 * while settings.setupCompleted is empty (a fresh install), or when the user
 * asks for it again. Five short steps, each skippable; every step saves its
 * own settings through PUT /settings and the last one (or "Use defaults")
 * writes setupCompleted. Escape never closes it by accident.
 */
import React, { useEffect, useRef, useState } from 'react'
import { mutate, post, errorText } from './api.js'
import { refreshSettings, setupRerun, createSignal } from './store.js'
import { MODEL_MAY, buildSettingsPatch, setPath, getPath } from './settings-model.js'
import { Switch, Note, copyText } from './ui.jsx'
import { announce } from './toasts.jsx'

export const SETUP_STEPS = [
  { id: 'welcome', title: 'Welcome' },
  { id: 'model', title: 'What the assistant may do on its own' },
  { id: 'automation', title: 'When the context fills up' },
  { id: 'ghosts', title: 'Ghosts and scripts' },
  { id: 'agents', title: 'Agents and tasks' },
  { id: 'ready', title: 'Ready' },
]

/** One line per modelMay switch, in the words of the guide. */
const MAY_COPY = {
  drop: 'Drop old tool output and messages from its own context.',
  edit: 'Rewrite its own earlier answers (every version is kept).',
  pin: 'Pin messages so they survive a reset.',
  new: 'Start a fresh context with a handoff, after its turn ends.',
  compact: 'Summarise its context into a checkpoint.',
  clear: 'Empty its context. Off by default: nothing is carried over.',
  post: 'Leave silent messages in other chats.',
  prompt: 'Send messages that wake other chats.',
  spawn: 'Start new agents.',
  cancel: 'Stop other chats.',
}

const TOOL_COPY = [
  ['chat', 'chat', 'Manage its own context (needed for everything above).'],
  ['chats', 'chats', 'List, prompt and post to other chats.'],
  ['tasks', 'tasks', 'Run and read background tasks.'],
]

/** Settings keys each step owns (the full objects, so a shallow merge on the host keeps the rest). */
const STEP_KEYS = { model: ['modelMay', 'tools'], automation: ['autoCompact'], ghosts: ['modules'], agents: ['modules', 'tasks'] }

export function stepPatch(stepId, form) {
  const full = buildSettingsPatch(form)
  const patch = {}
  for (const k of STEP_KEYS[stepId] || []) patch[k] = full[k]
  return patch
}

/** A random secret for the machine API (base64url, 43 characters). */
export function generateSecret() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const USAGE_LINE = 'dsh-post --kind report "<chat title>" "Build finished"   # reads DSH_CONDUCTOR_SECRET'

/** Shown while the guide is open in any tab (so other surfaces can tell). */
export const setupOpen = createSignal(false)

function Dots({ step }) {
  return (
    <ol className="cdx-dots" aria-label={'Step ' + (step + 1) + ' of ' + SETUP_STEPS.length}>
      {SETUP_STEPS.map((s, i) => (
        <li key={s.id} className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
          <span className="cdx-sr">{(i < step ? 'Done: ' : i === step ? 'Current: ' : '') + s.title}</span>
        </li>
      ))}
    </ol>
  )
}

/** Setup step: the global automatic level in three choices. */
function AutomationStep({ form, set }) {
  const ac = form.autoCompact || { percent: 0, action: 'compact', nudge: true }
  const choice = !ac.percent ? 'default' : ac.percent === 50 && ac.action === 'handoff' ? 'handoff50' : 'custom'
  return (
    <div className="cdx-wbody">
      <p className="cdx-help">What happens on its own when a chat's context gets full. A chat can change this later in Conductor, Automation.</p>
      <div className="cdx-radio" role="radiogroup" aria-label="When the context fills up">
        <label><input type="radio" name="cdx-setup-level" checked={choice === 'default'} onChange={() => set(['autoCompact'], { ...ac, percent: 0, action: 'compact' })} />
          <span>Default<span className="cdx-help" style={{ display: 'block' }}>DSH compacts at about 80%.</span></span></label>
        <label><input type="radio" name="cdx-setup-level" data-setup-handoff50 checked={choice === 'handoff50'} onChange={() => set(['autoCompact'], { ...ac, percent: 50, action: 'handoff' })} />
          <span>Hand off at 50%<span className="cdx-help" style={{ display: 'block' }}>A fresh context from a handoff, long before the model gets slow.</span></span></label>
        <label><input type="radio" name="cdx-setup-level" checked={choice === 'custom'} onChange={() => set(['autoCompact'], { ...ac, percent: ac.percent && choice !== 'handoff50' ? ac.percent : 65, action: ac.action || 'compact' })} />Custom</label>
      </div>
      {choice === 'custom' ? (
        <div className="cdx-acustom">
          <div className="cdx-btnrow">
            <input type="range" min={10} max={95} step={5} value={ac.percent} aria-label="Level, percent of the model window" style={{ flex: 1, accentColor: 'var(--clay)' }}
              onChange={(e) => set(['autoCompact', 'percent'], Number(e.target.value))} />
            <span className="cdx-num" style={{ width: 36, textAlign: 'right' }}>{ac.percent + '%'}</span>
          </div>
          <div className="cdx-radio" role="radiogroup" aria-label="What happens at the level" style={{ flexDirection: 'row', gap: 16 }}>
            <label><input type="radio" name="cdx-setup-act" checked={ac.action !== 'handoff'} onChange={() => set(['autoCompact', 'action'], 'compact')} />Compact</label>
            <label><input type="radio" name="cdx-setup-act" checked={ac.action === 'handoff'} onChange={() => set(['autoCompact', 'action'], 'handoff')} />Hand off</label>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ToggleRow({ title, desc, checked, onChange, warn }) {
  return (
    <div className="cdx-wrow">
      <div className="cdx-grow">
        <div className="t">{title}</div>
        {desc ? <div className="d">{desc}</div> : null}
        {warn && checked ? <div className="d warn" role="note">{warn}</div> : null}
      </div>
      <Switch checked={Boolean(checked)} label={title} onChange={onChange} />
    </div>
  )
}

/**
 * @param props.settings the GET /settings payload ({ settings, envSecretPresent })
 * @param props.onDone called after setupCompleted is written (or on close of a re-run)
 */
export function SetupGuide({ settings, onDone }) {
  const initial = (settings && settings.settings) || {}
  const [form, setForm] = useState(() => JSON.parse(JSON.stringify(initial)))
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null) // { text, retry }
  const [secretState, setSecretState] = useState(null) // { fingerprint }
  const secretRef = useRef('') // the generated secret: kept in memory only, never rendered or logged
  const headRef = useRef(null)
  const cur = SETUP_STEPS[step]
  const set = (path, value) => setForm((f) => setPath(f, path, value))
  const get = (path) => getPath(form, path)

  useEffect(() => { setupOpen.set(true); return () => setupOpen.set(false) }, [])
  useEffect(() => {
    if (headRef.current) headRef.current.focus({ preventScroll: true })
    announce('Setup, step ' + (step + 1) + ' of ' + SETUP_STEPS.length + ': ' + SETUP_STEPS[step].title)
  }, [step])
  useEffect(() => () => { secretRef.current = '' }, [])

  const run = async (fn, retry) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError({ text: errorText(e), retry })
      return false
    } finally { setBusy(false) }
  }

  const finish = async () => {
    const ok = await run(async () => {
      await mutate('PUT', '/settings', { setupCompleted: new Date().toISOString() })
      await refreshSettings()
    }, finish)
    if (ok) {
      setupRerun.set(false)
      announce('Setup finished.')
      if (onDone) onDone()
    }
  }

  const next = async () => {
    const patch = stepPatch(cur.id, form)
    if (Object.keys(patch).length) {
      const ok = await run(async () => { await mutate('PUT', '/settings', patch); refreshSettings() }, next)
      if (!ok) return
    }
    setStep((s) => Math.min(SETUP_STEPS.length - 1, s + 1))
  }
  const skip = () => { setError(null); setStep((s) => Math.min(SETUP_STEPS.length - 1, s + 1)) }
  const back = () => { setError(null); setStep((s) => Math.max(0, s - 1)) }

  const makeSecret = async () => {
    const value = generateSecret()
    await run(async () => {
      const r = await post('/secret', { secret: value })
      secretRef.current = value
      setSecretState({ fingerprint: r.fingerprint || '' })
      refreshSettings()
    }, makeSecret)
  }

  const onKeyDown = (e) => {
    // Escape must never throw the guide away; it only leaves an open text field
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (headRef.current) headRef.current.focus() }
  }

  const api = form.api || {}
  const alreadySecret = Boolean(api.secretConfigured || (settings && settings.envSecretPresent))

  return (
    <section className="cdx-wizard" aria-labelledby="cdx-setup-title" onKeyDown={onKeyDown} data-setup-step={cur.id}>
      <div className="cdx-wtop">
        <span className="cdx-help">{'Setup \u00b7 step ' + (step + 1) + ' of ' + SETUP_STEPS.length}</span>
        <Dots step={step} />
      </div>
      <h2 id="cdx-setup-title" ref={headRef} tabIndex={-1} className="cdx-wtitle">{cur.title}</h2>

      {cur.id === 'welcome' ? (
        <div className="cdx-wbody">
          <p>Conductor keeps this chat's context under control.</p>
          <ul className="cdx-wlist">
            <li><b>New context</b> starts fresh from a handoff the assistant writes, without losing the thread (/new).</li>
            <li><b>Drop</b> big items the model no longer needs, and <b>pin</b> the ones it must keep.</li>
            <li><b>Ghosts</b> are silent messages between chats and scripts: they inform without waking anyone.</li>
          </ul>
        </div>
      ) : null}

      {cur.id === 'model' ? (
        <div className="cdx-wbody">
          <p className="cdx-help">You can always do all of this yourself. These switches decide what the assistant may do on its own.</p>
          <div className="cdx-wgroup" role="group" aria-label="The assistant may">
            {MODEL_MAY.map(([k, title]) => (
              <ToggleRow key={k} title={title.replace(/ \(.*\)$/, '')} desc={MAY_COPY[k]} checked={get(['modelMay', k])} onChange={(v) => set(['modelMay', k], v)} />
            ))}
          </div>
          <h3 className="cdx-wsub">Model tools</h3>
          <div className="cdx-wgroup" role="group" aria-label="Model tools">
            {TOOL_COPY.map(([k, title, desc]) => (
              <ToggleRow key={k} title={title + ' tool'} desc={desc} checked={get(['tools', k])} onChange={(v) => set(['tools', k], v)} />
            ))}
            <ToggleRow title="Keep old orch_* tool names" desc="Only if prompts or agents still call the dsh-orchestrator tools." checked={get(['tools', 'legacy'])} onChange={(v) => set(['tools', 'legacy'], v)} />
          </div>
        </div>
      ) : null}

      {cur.id === 'automation' ? (
        <AutomationStep form={form} set={set} />
      ) : null}

      {cur.id === 'ghosts' ? (
        <div className="cdx-wbody">
          <ToggleRow title="Inbox and ghosts" desc="Other chats and scripts can leave silent messages here. They show in the chat and wake nobody."
            checked={get(['modules', 'posts'])} onChange={(v) => set(['modules', 'posts'], v)} />
          <h3 className="cdx-wsub">Scripts (machine API)</h3>
          <p className="cdx-help">A secret lets scripts and cron jobs post ghosts with dsh-post. Without one the machine API stays closed.</p>
          {secretState ? (
            <div className="cdx-wsecret" data-secret-ready>
              <div>{'Secret saved' + (secretState.fingerprint ? ' (fingerprint ' + secretState.fingerprint + ')' : '') + '. It is shown nowhere; copy it now and store it as DSH_CONDUCTOR_SECRET where your scripts run.'}</div>
              <div className="cdx-btnrow">
                <button type="button" className="cdx-btn s" data-copy-secret onClick={async () => { const ok = await copyText(secretRef.current); announce(ok ? 'Secret copied.' : 'Copy is not available in this browser.') }}>Copy secret</button>
                <button type="button" className="cdx-btn s g" data-copy-usage onClick={async () => { const ok = await copyText(USAGE_LINE); announce(ok ? 'Usage line copied.' : 'Copy is not available in this browser.') }}>Copy usage line</button>
              </div>
              <pre className="cdx-pre log">{USAGE_LINE}</pre>
            </div>
          ) : (
            <div className="cdx-btnrow">
              <button type="button" className="cdx-btn s" data-generate-secret disabled={busy} onClick={makeSecret}>{alreadySecret ? 'Replace the secret' : 'Generate a secret'}</button>
              {alreadySecret ? <span className="cdx-help">{'A secret is already set' + (api.secretFingerprint ? ' (' + api.secretFingerprint + ')' : '') + '.'}</span> : <span className="cdx-help">Or skip: you can add one later in Settings.</span>}
            </div>
          )}
        </div>
      ) : null}

      {cur.id === 'agents' ? (
        <div className="cdx-wbody">
          <ToggleRow title="Agents and tasks" desc="Spawn and message other chats, run background tasks, see what is running."
            checked={get(['modules', 'orchestration'])} onChange={(v) => set(['modules', 'orchestration'], v)} />
          <ToggleRow title="Shell command tasks" desc="Off by default."
            warn="Anything that can create a task can then run shell commands on this host."
            checked={get(['tasks', 'allowCommandTasks'])} onChange={(v) => set(['tasks', 'allowCommandTasks'], v)} />
          <ToggleRow title="Remote runners" desc="Off by default."
            warn="Tasks may then run over ssh or http on other machines."
            checked={get(['tasks', 'allowRemoteRunners'])} onChange={(v) => set(['tasks', 'allowRemoteRunners'], v)} />
        </div>
      ) : null}

      {cur.id === 'ready' ? (
        <div className="cdx-wbody">
          <ul className="cdx-wlist">
            <li>When the meter runs high, type <b>/new</b> or press <b>New context</b>.</li>
            <li>In <b>Context</b>, drop the biggest items first.</li>
            <li>Star a message to <b>pin</b> it across every reset.</li>
          </ul>
          <p className="cdx-help">Everything here can be changed later in Settings, Conductor.</p>
        </div>
      ) : null}

      {error ? (
        <Note tone="bad" role="alert" actions={<>
          {error.retry ? <button type="button" className="cdx-btn s" onClick={() => error.retry()}>Retry</button> : null}
          {cur.id !== 'welcome' && cur.id !== 'ready' ? <button type="button" className="cdx-btn s g" onClick={skip}>Continue without saving</button> : null}
        </>}>
          {'Couldn\u2019t save: ' + error.text + '. Nothing on this step was changed.'}
        </Note>
      ) : null}

      <div className="cdx-wnav">
        {cur.id === 'welcome' ? (
          <>
            <button type="button" className="cdx-btn p" data-setup-start disabled={busy} onClick={() => setStep(1)}>Set up (1 minute)</button>
            <button type="button" className="cdx-btn g" data-setup-defaults disabled={busy} onClick={finish}>Use defaults</button>
          </>
        ) : cur.id === 'ready' ? (
          <>
            <button type="button" className="cdx-btn g" disabled={busy} onClick={back}>Back</button>
            <span className="cdx-spacer" />
            <button type="button" className="cdx-btn p" data-setup-finish disabled={busy} onClick={finish}>{busy ? 'Saving\u2026' : 'Open Conductor'}</button>
          </>
        ) : (
          <>
            <button type="button" className="cdx-btn g" disabled={busy} onClick={back}>Back</button>
            <span className="cdx-spacer" />
            <button type="button" className="cdx-btn g" data-setup-skip disabled={busy} onClick={skip}>Skip</button>
            <button type="button" className="cdx-btn p" data-setup-next disabled={busy} onClick={next}>{busy ? 'Saving\u2026' : 'Next'}</button>
          </>
        )}
      </div>
    </section>
  )
}
