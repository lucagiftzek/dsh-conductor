/**
 * HTTP helpers for /dsh-conductor/api. Every mutation carries the host CSRF
 * gate's requirements: same-origin credentials, a JSON content type and the
 * plugin's X-Requested-With value. The machine endpoints (/remote/*) are
 * secret-only and never called from the browser.
 */

export const PLUGIN_ID = 'dsh-conductor'
export const API = '/' + PLUGIN_ID + '/api'

/** An API failure with its HTTP status and host error code. */
export class ApiError extends Error {
  constructor(message, status, code, offline) {
    super(message)
    this.status = status
    this.code = code
    /** True when the plugin route itself is unreachable (network error or no JSON route). */
    this.offline = Boolean(offline)
  }
}

async function parse(response) {
  let body = null
  try { body = await response.json() } catch { body = null }
  if (!response.ok || (body && body.ok === false)) {
    const offline = !body && (response.status === 404 || response.status === 502 || response.status === 503 || response.status === 504)
    const message = (body && (body.error || body.text)) || (offline ? 'Conductor service unreachable' : 'HTTP ' + response.status)
    throw new ApiError(String(message), response.status, body && body.code, offline)
  }
  return body || {}
}

function networkError(error) {
  if (error instanceof ApiError) return error
  return new ApiError(String((error && error.message) || error || 'network error'), 0, 'network', true)
}

export function getJson(path) {
  return fetch(API + path, { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then(parse, (e) => { throw networkError(e) })
}

export function mutate(method, path, body) {
  return fetch(API + path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-requested-with': PLUGIN_ID },
    body: JSON.stringify(body || {}),
  }).then(parse, (e) => { throw networkError(e) })
}

export const post = (path, body) => mutate('POST', path, body)

const enc = encodeURIComponent

/** The Conductor session API, one object per chat. */
export function sessionApi(sessionId) {
  const base = '/conductor/session/' + enc(sessionId)
  return {
    /** The whole view, or { unchanged: true, fingerprint } when `since` still matches. */
    view: (since) => getJson(base + (since ? '?since=' + enc(since) : '')),
    item: (seq) => getJson(base + '/item/' + enc(seq)),
    reset: (kind, focus) => post(base + '/reset', focus ? { kind, focus } : { kind }),
    /** Abort a running /new, /clear or /force-compact (the context stays unchanged). */
    cancelReset: () => post(base + '/reset/cancel', {}),
    drop: (seqs) => post(base + '/drop', { seqs }),
    undrop: (target) => post(base + '/undrop', { target }),
    pin: (target, note) => post(base + '/pin', note ? { target, note } : { target }),
    unpin: (target) => post(base + '/unpin', { target }),
    /** Edit a pin's note; an empty note removes it. */
    pinNote: (target, note) => post(base + '/pin-note', { target, note: note || '' }),
    edit: (target, text, reason) => post(base + '/edit', reason ? { target, text, reason } : { target, text }),
    restore: (messageId, version) => post(base + '/restore', { messageId, version }),
    inbox: (action, ids) => post(base + '/inbox', ids ? { action, ids } : { action }),
    // automation
    level: (spec) => post(base + '/level', spec),
    autoNew: (spec) => post(base + '/auto-new', spec),
    relay: (to) => post(base + '/relay', { to: to || null }),
    template: (template) => post(base + '/template', { template: template || '' }),
    recovery: (enabled) => post(base + '/recovery', { enabled: Boolean(enabled) }),
    // checkpoints and rewind
    checkpoints: (previewId) => getJson(base + '/checkpoints' + (previewId ? '?preview=' + enc(previewId) : '')),
    checkpoint: (name) => post(base + '/checkpoint', name ? { name } : {}),
    rewind: (opts) => post(base + '/rewind', opts),
    rewindUndo: () => post(base + '/rewind/undo', {}),
    // search earlier context (archives, drops, handoffs)
    recall: (q, limit = 10) => getJson(base + '/recall?q=' + enc(q) + '&limit=' + enc(limit)),
  }
}

/** Silent message into another chat (no wake). */
export function postToChat({ to, text, kind, visible, fromSessionId }) {
  const body = { to, text, kind: kind || 'note', visible: visible || 'user+model' }
  if (fromSessionId) body.fromSessionId = fromSessionId
  return post('/conductor/post', body)
}

export function errorText(error) {
  return String((error && error.message) || error || 'Unknown error')
}
