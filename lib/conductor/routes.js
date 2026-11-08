/**
 * HTTP routes of the Conductor sidebar and the silent-post machine API,
 * mounted under /dsh-conductor/api by lib/api.js, which has already applied
 * the browser trust fence and CSRF gate (or the machine secret) before any
 * of these run.
 *
 *   GET  /conductor/session/:id[?since=fp]       the whole sidebar view, or { unchanged: true, fingerprint }
 *   GET  /conductor/session/:id/item/:seq        one full context item
 *   GET  /conductor/session/:id/recall?q=        search this chat's archives, drops and handoffs
 *   POST /conductor/session/:id/relay            { to: chat | null }  final answers go there as ghosts
 *   GET  /conductor/session/:id/checkpoints[?preview=<id>]   checkpoints, newest first, and what a rewind would restore
 *   POST /conductor/session/:id/checkpoint       { name }
 *   POST /conductor/session/:id/rewind           { target, chat, files, branch, force }
 *   POST /conductor/session/:id/rewind/undo      put back the files the last rewind restored
 *   POST /conductor/session/:id/recovery         { enabled }  automatic resume for this chat
 *   POST /conductor/session/:id/level            { percent: 10..95, action: compact|handoff } | { off } | { paused } | { nudge }
 *   POST /conductor/session/:id/auto-new         { daily: 'HH:MM' } | { everyTurns: N } | { off: true }
 *   POST /conductor/session/:id/template         { template }  this chat's handoff sections ('' = default)
 *   POST /conductor/session/:id/reset            { kind: new|clear|force-compact|pointer, focus }
 *   POST /conductor/session/:id/drop             { seqs | last | tool | file | larger }
 *   POST /conductor/session/:id/reset/cancel     abort a running reset (the context stays as it was)
 *   POST /conductor/session/:id/undrop           { target: last|all|pending|<id> }
 *   POST /conductor/session/:id/pin              { target, note }
 *   POST /conductor/session/:id/unpin            { target }
 *   POST /conductor/session/:id/pin-note         { target, note }
 *   POST /conductor/session/:id/edit             { target, text, reason }
 *   POST /conductor/session/:id/restore          { messageId, version }
 *   POST /conductor/session/:id/inbox            { action: read|unread|dismiss|undismiss|add, ids }
 *   POST /conductor/post                         { to, text, kind, visible, fromSessionId }
 *   POST /remote/post   (machine secret only)    { to, text, from, kind, visible }
 */
import { randomUUID } from 'node:crypto'

const STATUS = { invalid: 400, 'not-found': 404, busy: 409, limit: 409, ambiguous: 409, forbidden: 403, gone: 410 }
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

export function makeConductorRoute(ctx, conductor, { warn = () => {} } = {}) {
  const lastReset = new Map() // sessionId -> { kind, ok, text, at }

  function selectorOf(body) {
    const selector = {}
    if (Array.isArray(body.seqs)) selector.seqs = body.seqs.map(Number).filter(Number.isInteger).slice(0, 500)
    if (Number.isInteger(body.last)) selector.last = body.last
    if (typeof body.tool === 'string') selector.tool = body.tool.slice(0, 120)
    if (Number.isInteger(body.keepNewest)) selector.keepNewest = body.keepNewest
    if (typeof body.file === 'string') selector.file = body.file.slice(0, 500)
    if (Number.isFinite(body.larger)) selector.larger = body.larger
    return selector
  }

  /** Run a reset as a real slash command, so the chat shows it as a command row. */
  async function startReset(sessionId, kind, focus) {
    const agent = await conductor.agentFor(sessionId)
    if (conductor.isResetting(sessionId)) return { status: 409, body: { ok: false, error: 'A reset is already running in this chat.' } }
    if (agent.status === 'running') return { status: 409, body: { ok: false, error: 'The agent is still working. Wait until it finishes, then try again.' } }
    const commands = ctx.get('commands')
    const line = kind === 'pointer' ? '/force-compact --pointer' : `/${kind}${focus ? ` ${String(focus).slice(0, 2000)}` : ''}`
    const started = Date.now()
    const run = (async () => {
      let ok = false
      let text = ''
      try {
        const out = await commands.execute(agent, line, [], AbortSignal.timeout(20 * 60 * 1000))
        const result = out?.result ?? out
        ok = result?.kind === 'success'
        text = result?.text ?? (ok ? 'Done.' : 'The command did not run.')
      } catch (error) {
        text = String(error?.message || error)
      }
      lastReset.set(sessionId, { id: randomUUID().slice(0, 8), kind, ok, text, at: new Date().toISOString(), ms: Date.now() - started })
      conductor.store.update(sessionId, () => {}) // bump the revision so the sidebar refreshes
    })()
    run.catch((error) => warn(`reset from the sidebar failed: ${error?.message || error}`))
    return { status: 202, body: { ok: true, started: true } }
  }

  return async function conductorRoute(sub, method, { machine, body, url }, send) {
    try {
      if (method === 'POST' && (sub === '/conductor/post' || (machine && sub === '/remote/post'))) {
        const result = await conductor.post({
          to: body?.to,
          text: body?.text,
          from: machine ? (typeof body?.from === 'string' && body.from.trim() ? body.from.trim() : 'a script') : body?.from,
          fromSessionId: typeof body?.fromSessionId === 'string' && SAFE.test(body.fromSessionId) ? body.fromSessionId : undefined,
          kind: body?.kind,
          visible: body?.visible ?? 'user+model',
        }, { by: machine ? 'script' : 'user' })
        send(202, result)
        return true
      }
      const m = sub.match(/^\/conductor\/session\/([^/]+)(\/.*)?$/)
      if (!m) return false
      const sessionId = decodeURIComponent(m[1])
      if (!SAFE.test(sessionId)) { send(400, { ok: false, error: 'invalid session id' }); return true }
      const rest = m[2] ?? ''
      const b = body ?? {}

      if (method === 'GET' && rest === '') {
        // ?since=<fingerprint> answers { unchanged: true } when nothing moved (cheap polling)
        const since = url?.searchParams?.get('since') || undefined
        const view = await conductor.view(sessionId, { since })
        send(200, view.unchanged ? view : { ...view, lastReset: lastReset.get(sessionId) ?? null })
        return true
      }
      if (method === 'GET' && rest === '/checkpoints') {
        if (!conductor.checkpoints) { send(503, { ok: false, error: 'checkpoints are not available' }); return true }
        const target = url?.searchParams?.get('preview')
        send(200, { ok: true, checkpoints: conductor.checkpoints.list(sessionId), preview: target ? conductor.checkpoints.preview(sessionId, target) : null })
        return true
      }
      if (method === 'GET' && rest === '/recall') {
        const q = url?.searchParams?.get('q') || ''
        send(200, conductor.recallFor(sessionId, q, { limit: Number(url?.searchParams?.get('limit')) || 10 }))
        return true
      }
      if (method === 'GET' && rest.startsWith('/item/')) {
        send(200, await conductor.item(sessionId, Number(rest.slice(6))))
        return true
      }
      if (method !== 'POST') return false
      switch (rest) {
        case '/reset': {
          const kind = ['new', 'clear', 'force-compact', 'pointer'].includes(b.kind) ? b.kind : null
          if (!kind) { send(400, { ok: false, error: 'kind must be new, clear, force-compact or pointer' }); return true }
          const out = await startReset(sessionId, kind, b.focus)
          send(out.status, out.body)
          return true
        }
        case '/checkpoint': {
          if (!conductor.checkpoints) { send(503, { ok: false, error: 'checkpoints are not available' }); return true }
          send(200, conductor.checkpoints.mark(sessionId, typeof b.name === 'string' ? b.name : undefined, { by: 'user' }))
          return true
        }
        case '/rewind': {
          if (!conductor.checkpoints) { send(503, { ok: false, error: 'checkpoints are not available' }); return true }
          send(200, await conductor.checkpoints.rewind(sessionId, b.target ?? 'last', { chat: b.chat !== false, files: b.files !== false, branch: b.branch === true, force: b.force === true, by: 'user' }))
          return true
        }
        case '/rewind/undo': {
          if (!conductor.checkpoints) { send(503, { ok: false, error: 'checkpoints are not available' }); return true }
          send(200, conductor.checkpoints.undoRestore(sessionId, { by: 'user' }))
          return true
        }
        case '/recovery': {
          if (!conductor.recovery) { send(503, { ok: false, error: 'recovery is not available' }); return true }
          if (typeof b.enabled !== 'boolean') { send(400, { ok: false, error: 'enabled (boolean) is required' }); return true }
          send(200, conductor.recovery.setChat(sessionId, b.enabled, { by: 'user' }))
          return true
        }
        case '/level': {
          const spec = b.off ? { off: true } : {}
          if (Number.isFinite(b.percent)) { if (b.percent < 10 || b.percent > 95) { send(400, { ok: false, error: 'percent must be 10 to 95' }); return true } spec.percent = b.percent }
          if (b.action === 'compact' || b.action === 'handoff') spec.action = b.action
          if (typeof b.paused === 'boolean') spec.paused = b.paused
          if (typeof b.nudge === 'boolean') spec.nudge = b.nudge
          send(200, conductor.setLevel(sessionId, spec, { by: 'user' }))
          return true
        }
        case '/auto-new': {
          if (!conductor.automation) { send(503, { ok: false, error: 'automation is not available' }); return true }
          const spec = b.off ? { off: true } : b.daily ? { daily: String(b.daily) } : b.everyTurns ? { everyTurns: Number(b.everyTurns) } : { error: 'daily, everyTurns or off is required' }
          if (spec.daily && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(spec.daily)) { send(400, { ok: false, error: 'daily needs HH:MM' }); return true }
          if (spec.everyTurns && !(Number.isInteger(spec.everyTurns) && spec.everyTurns >= 2 && spec.everyTurns <= 1000)) { send(400, { ok: false, error: 'everyTurns must be 2 to 1000' }); return true }
          if (spec.error) { send(400, { ok: false, error: spec.error }); return true }
          send(200, conductor.automation.setAutoNew(sessionId, spec, { by: 'user' }))
          return true
        }
        case '/relay': send(200, await conductor.setRelay(sessionId, b.to ?? null, { by: 'user' })); return true
        case '/template': send(200, conductor.setHandoffTemplate(sessionId, b.template ?? '', { by: 'user' })); return true
        case '/reset/cancel': send(200, conductor.cancelReset(sessionId, { by: 'user' })); return true
        case '/pin-note': send(200, conductor.notePin(sessionId, b.target, b.note, { by: 'user' })); return true
        case '/drop': send(200, await conductor.drop(sessionId, selectorOf(b), { by: 'user' })); return true
        case '/undrop': send(200, await conductor.undrop(sessionId, b.target ?? 'last', { by: 'user' })); return true
        case '/pin': send(200, await conductor.pin(sessionId, b.target ?? 'last', { note: b.note, by: 'user' })); return true
        case '/unpin': send(200, conductor.unpin(sessionId, b.target ?? 'last', { by: 'user' })); return true
        case '/edit': send(200, await conductor.edit(sessionId, b.target, b.text, { by: 'user', reason: b.reason })); return true
        case '/restore': send(200, await conductor.restoreVersion(sessionId, b.messageId, b.version, { by: 'user' })); return true
        case '/inbox': {
          const ids = Array.isArray(b.ids) ? b.ids.filter((x) => typeof x === 'string').slice(0, 300) : 'all'
          if (b.action === 'read' || b.action === 'unread') send(200, conductor.markRead(sessionId, ids, b.action === 'read'))
          else if (b.action === 'dismiss') send(200, conductor.dismiss(sessionId, ids === 'all' ? undefined : ids))
          else if (b.action === 'undismiss') send(200, conductor.undismiss(sessionId, ids === 'all' ? undefined : ids))
          else if (b.action === 'add' && Array.isArray(ids) && ids.length === 1) send(200, await conductor.addToContext(sessionId, ids[0]))
          else send(400, { ok: false, error: 'action must be read, unread, dismiss, undismiss or add (one id)' })
          return true
        }
        default:
          return false
      }
    } catch (error) {
      const status = STATUS[error?.code] ?? 500
      send(status, { ok: false, error: String(error?.message || error), code: error?.code })
      return true
    }
  }
}
