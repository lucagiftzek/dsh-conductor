/**
 * dsh-conductor: runners: where work executes.
 *
 * A runner is an operator-declared execution target (settings, never code):
 *
 *   local  spawn on this host, argv only: ['bash','-lc', command]: never a
 *          shell string we build by hand, never an eval.
 *   ssh    spawn the ssh client with argv [bin, options..., target, '--',
 *          command]: the command is ONE argv element on this side; the
 *          remote shell interpreting it is the operator's own machine and
 *          the operator's own declared target.
 *   http   a remote TOOL SERVER speaking this plugin's documented contract:
 *          POST {url} {kind, spec, timeoutMs} -> {ok, status, output, detail}.
 *          Any host running dsh-conductor serves this contract at
 *          /dsh-conductor/api/remote/run, and so can anything else that
 *          implements the same JSON.
 *
 * Every spawn runs under a scrubbed environment: PATH/HOME/LANG only, plus
 * nothing else: no SSH_AUTH_SOCK, no tokens, no inherited DSH_* secrets.
 * Runner selection honours an explicit id, else the configured default, else
 * round-robin across enabled runners of a matching kind (the "automated"
 * routing).
 */

'use strict'

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

export function scrubbedEnv(extra = {}) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: homedir(),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    ...extra,
  }
}

/**
 * Run a command through a runner. Never throws; resolves a result object.
 * onChunk(text, 'stdout'|'stderr'), when given, receives output AS IT ARRIVES
 * so the caller can stream live progress into the task record.
 * onStart(kill), when given, receives a kill function as soon as the work is
 * running: it terminates the WHOLE process group (SIGTERM, then SIGKILL after
 * a grace period) so compound commands like `a; sleep 60` leave no orphans.
 * For ssh runners it ends the local ssh client; for http runners it aborts
 * the request.
 */
export function runOnRunner(runner, command, { cwd = '/', timeoutMs = 600000, env = {}, onChunk, onStart } = {}) {
  if (!runner) return Promise.resolve({ ok: false, status: 'no-runner', error: 'runner is not configured', stdout: '', stderr: '', code: null })
  if (runner.kind === 'http') return runViaToolServer(runner, { kind: 'command', spec: { command, cwd }, timeoutMs, onStart })
  return new Promise((resolvePromise) => {
    let bin
    let args
    if (runner.kind === 'ssh') {
      const s = runner.ssh
      bin = s.bin
      args = [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=' + Math.ceil(Math.min(s.connectTimeoutMs, 60000) / 1000),
        ...s.extraArgs,
        s.target,
        '--',
        String(command),
      ]
    } else {
      bin = 'bash'
      args = ['-lc', String(command)]
    }
    let child
    try {
      // detached: the child leads its own process group, so a kill reaches
      // every descendant (bash -lc 'a; b' forks; killing bash alone orphans b).
      child = spawn(bin, args, { cwd: runner.kind === 'local' ? cwd : '/', env: scrubbedEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (e) {
      resolvePromise({ ok: false, status: 'spawn-error', error: String(e && e.message || e), stdout: '', stderr: '', code: null })
      return
    }
    let out = ''
    let err = ''
    let done = false
    const cap = 512 * 1024
    const signalGroup = (sig) => {
      try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch { /* already gone */ } }
    }
    let graceTimer = null
    const kill = () => {
      if (done) return
      signalGroup('SIGTERM')
      if (!graceTimer) {
        graceTimer = setTimeout(() => { if (!done) signalGroup('SIGKILL') }, 3000)
        if (typeof graceTimer.unref === 'function') graceTimer.unref()
      }
    }
    const timer = setTimeout(() => signalGroup('SIGKILL'), Math.max(500, timeoutMs))
    if (typeof timer.unref === 'function') timer.unref()
    if (typeof onStart === 'function') { try { onStart(kill) } catch { /* the hook must never break the run */ } }
    child.stdout.on('data', (d) => {
      if (out.length < cap) out += d.toString('utf8')
      if (typeof onChunk === 'function') { try { onChunk(d.toString('utf8'), 'stdout') } catch { /* streaming must never break the run */ } }
    })
    child.stderr.on('data', (d) => {
      if (err.length < cap) err += d.toString('utf8')
      if (typeof onChunk === 'function') { try { onChunk(d.toString('utf8'), 'stderr') } catch { /* same */ } }
    })
    const finish = (code, signal) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      resolvePromise({
        ok: code === 0,
        status: code === 0 ? 'completed' : code === null ? 'failed' : 'failed',
        detail: 'exit code: ' + String(code) + (signal ? ' (' + signal + ')' : ''),
        stdout: out,
        stderr: err,
        code,
        via: runner.kind + ':' + runner.id,
      })
    }
    child.on('error', (e) => { err += String(e && e.message || e); finish(null, null) })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** The tool-server contract call (http runners). Never throws. */
export async function runViaToolServer(runner, { kind, spec, timeoutMs = 60000, onStart }) {
  const h = runner.http
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  if (h.secretEnv && process.env[h.secretEnv]) {
    headers['authorization'] = 'Bearer ' + process.env[h.secretEnv]
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(500, h.timeoutMs || timeoutMs))
  if (typeof onStart === 'function') { try { onStart(() => controller.abort()) } catch { /* advisory */ } }
  try {
    const res = await fetch(h.url, {
      method: h.method,
      headers,
      body: JSON.stringify({ kind, spec, timeoutMs }),
      signal: controller.signal,
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = null }
    if (!res.ok) {
      return { ok: false, status: 'remote-error', detail: 'HTTP ' + res.status, output: String(text).slice(0, 4000), code: res.status, via: 'http:' + runner.id }
    }
    const ok = Boolean(data && data.ok)
    return {
      ok,
      status: ok ? 'completed' : 'failed',
      detail: data && typeof data.detail === 'string' ? data.detail : 'remote tool server replied',
      stdout: typeof (data && data.output) === 'string' ? data.output : JSON.stringify(data),
      stderr: '',
      code: ok ? 0 : 1,
      via: 'http:' + runner.id,
    }
  } catch (e) {
    const aborted = e && e.name === 'AbortError'
    return {
      ok: false,
      status: aborted ? 'timeout' : 'unreachable',
      detail: aborted ? 'tool server timeout after ' + (h.timeoutMs || timeoutMs) + 'ms' : String(e && e.message || e),
      stdout: '',
      stderr: '',
      code: null,
      via: 'http:' + runner.id,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Health probe for the runners view. Never throws. */
export async function probeRunner(runner) {
  const started = Date.now()
  if (runner.kind === 'http') {
    const r = await runViaToolServer(runner, { kind: 'probe', spec: {}, timeoutMs: 8000 })
    return { runner: runner.id, kind: runner.kind, ok: r.ok, ms: Date.now() - started, detail: r.detail || r.status, at: Date.now() }
  }
  const cmd = runner.kind === 'ssh' ? 'echo orchestrator-probe' : 'echo orchestrator-probe'
  const r = await runOnRunner(runner, cmd, { timeoutMs: 15000 })
  return {
    runner: runner.id,
    kind: runner.kind,
    ok: r.ok && String(r.stdout).includes('orchestrator-probe'),
    ms: Date.now() - started,
    detail: r.ok ? 'reachable' : (r.status + (r.detail ? ': ' + r.detail : '')).slice(0, 200),
    at: Date.now(),
  }
}

/**
 * Resolve the runner a task should use.
 *   requested 'auto' | '' | undefined -> default runner (or round-robin)
 *   explicit id                       -> that runner (must exist + be enabled)
 * kindFilter narrows the auto pool (e.g. 'command-capable').
 */
export function pickRunner(runners, requested, { defaultRunner = 'local', policy = 'default' } = {}) {
  const byId = new Map(runners.map((r) => [r.id, r]))
  const enabled = runners.filter((r) => r.enabled !== false)
  if (requested && requested !== 'auto') {
    const r = byId.get(requested)
    if (!r) return { runner: null, error: 'unknown runner: ' + requested }
    if (r.enabled === false) return { runner: null, error: 'runner is disabled: ' + requested }
    return { runner: r, error: null }
  }
  const def = byId.get(defaultRunner)
  if (def && def.enabled !== false) {
    if (policy !== 'round-robin' || def.kind === 'local') return { runner: def, error: null }
  }
  const pool = enabled.length ? enabled : runners.filter((r) => r.id === 'local')
  if (!pool.length) return { runner: null, error: 'no enabled runners' }
  const pick = pool[Math.floor(Math.random() * pool.length)]
  return { runner: pick, error: null }
}

export const __runners = { scrubbedEnv }
