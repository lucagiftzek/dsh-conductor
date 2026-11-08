/**
 * dsh-conductor: route security.
 *
 * Two caller classes reach this plugin's route, and they are gated
 * differently on purpose:
 *
 *   BROWSER (the Settings section + the sidebar tab, same-origin fetch)
 *     R1 loopback peer        dsh-web binds 127.0.0.1; a non-loopback peer
 *                             means something is very wrong.
 *     R2 trust fence          a behavioural copy of the harness's own
 *                             isTrustedApiRequest (BSD-3-Clause; also
 *                             vendored by dsh-better-sidebar for the same
 *                             reason). Host must be loopback or a configured
 *                             trusted authority; sec-fetch-site must not be
 *                             cross-site; an Origin, if present, must match
 *                             the Host. This is the DNS-rebinding defence.
 *     R3 CSRF                 on mutations: Origin + sec-fetch-site PRESENT
 *                             and same-origin, JSON content-type, and the
 *                             plugin's X-Requested-With header: a
 *                             cross-origin form can set none of these without
 *                             a CORS preflight, and this route answers none.
 *     R4 session cookie       on mutations: the harness browser-session
 *                             cookie must be PRESENT (presence-only; the
 *                             signing secret stays in the harness).
 *
 *   MACHINE (curl / cron / another box; no browser metadata)
 *     M1 the operator secret  x-conductor-secret header or Bearer token,
 *                             compared in constant time; env always wins over
 *                             the stored one; absent secret = fail closed.
 *     M2 rate limit           per source IP, plus a tighter budget for
 *                             wrong-secret attempts.
 *
 * A browser request that ALSO carries a valid machine secret is treated as a
 * machine request (the secret is strictly stronger evidence than the browser
 * gates). No GET ever mutates; the mutating paths are POST/PUT only.
 */

'use strict'

import { createHash, timingSafeEqual } from 'node:crypto'

const COOKIE_PREFIX = 'dsh-auth-'

// ── header helpers ──────────────────────────────────────────────────────────

function header(headers, name) {
  const v = headers ? headers[name] : undefined
  return typeof v === 'string' ? v : undefined
}

function parseAuthority(authority) {
  try { return new URL('http://' + authority) } catch { return undefined }
}

export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

export function isLoopbackPeer(remoteAddress) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(remoteAddress ?? ''))
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    const port = entryUrl.port !== '' ? entryUrl.port : (() => {
      try { return new URL('https://' + entry).port } catch { return '' }
    })()
    return port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/** R2, read path: the harness's own fence, behaviour for behaviour. */
export function isTrustedApiRequest(request, trustedHosts = []) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

/** The harness browser-session cookie name for this request's authority. */
export function harnessCookieName(hostHeader) {
  const hostUrl = parseAuthority(String(hostHeader ?? ''))
  if (!hostUrl) return null
  const digest = createHash('sha256').update(hostUrl.host).digest()
  return COOKIE_PREFIX + digest.toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** Presence-only read of one exact cookie (no general Cookie decoding). */
export function hasCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || !name) return false
  for (const segment of cookieHeader.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim().length > 0
  }
  return false
}

// ── browser gates ───────────────────────────────────────────────────────────

/** Read gate: R1 + R2. Cheap, and a failure is never destructive. */
export function checkReadRequest(req, { trustedHosts = [] } = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return { ok: false, status: 405, reason: 'read route is GET/HEAD only' }
  }
  if (!isLoopbackPeer(req.socket && req.socket.remoteAddress)) {
    return { ok: false, status: 403, reason: 'non-loopback peer' }
  }
  if (!isTrustedApiRequest(req, trustedHosts)) {
    return { ok: false, status: 403, reason: 'cross-site or untrusted Host' }
  }
  return { ok: true }
}

/**
 * Browser mutation gate: R1 + R2 + R3 + R4. Every refusal names exactly one
 * layer, so a misconfiguration is debuggable without weakening anything.
 */
export function checkBrowserMutation(req, { trustedHosts = [], requireCookie = true, pluginId } = {}) {
  if (req.method !== 'POST' && req.method !== 'PUT') {
    return { ok: false, status: 405, layer: 'R0', reason: 'browser mutations are POST/PUT only; no GET ever mutates' }
  }
  if (!isLoopbackPeer(req.socket && req.socket.remoteAddress)) {
    return { ok: false, status: 403, layer: 'R1', reason: 'non-loopback peer' }
  }
  if (!isTrustedApiRequest(req, trustedHosts)) {
    return { ok: false, status: 403, layer: 'R2', reason: 'cross-site or untrusted Host' }
  }
  const site = header(req.headers, 'sec-fetch-site')
  if (site !== 'same-origin') {
    return { ok: false, status: 403, layer: 'R3', reason: 'sec-fetch-site must be same-origin on a mutation (got ' + String(site) + ')' }
  }
  const origin = header(req.headers, 'origin')
  if (origin === undefined) {
    return { ok: false, status: 403, layer: 'R3', reason: 'Origin must be present on a mutation' }
  }
  const ctype = (header(req.headers, 'content-type') || '').split(';')[0].trim().toLowerCase()
  if (ctype !== 'application/json') {
    return { ok: false, status: 415, layer: 'R3', reason: 'content-type must be application/json (a form post cannot reach this route)' }
  }
  if (header(req.headers, 'x-requested-with') !== pluginId) {
    return { ok: false, status: 403, layer: 'R3', reason: 'x-requested-with must name this plugin' }
  }
  if (requireCookie) {
    const name = harnessCookieName(header(req.headers, 'host'))
    if (!name || !hasCookie(header(req.headers, 'cookie'), name)) {
      return { ok: false, status: 403, layer: 'R4', reason: 'no harness browser-session cookie on this request' }
    }
  }
  return { ok: true }
}

// ── machine-secret auth ─────────────────────────────────────────────────────

/** Constant-time comparison; hashes first so length differences leak nothing. */
export function secretEquals(presented, configured) {
  if (typeof presented !== 'string' || presented.length === 0) return false
  if (typeof configured !== 'string' || configured.length === 0) return false
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(configured, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** Pull the candidate secret out of request headers (both accepted forms). */
export function presentedSecret(headers, headerName) {
  const direct = headers[headerName]
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim().slice(0, 512)
  const auth = headers.authorization
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) {
    const m = auth.replace(/^bearer\s+/i, '').trim()
    if (m) return m.slice(0, 512)
  }
  return ''
}

/**
 * Per-IP sliding-minute limiter. Pure-ish closure; clock injectable for tests.
 * (Same shape as the DSH-Idle-Watchdog limiter, battle-tested in production.)
 */
export function makeRateLimiter(limitsFn, clock = () => Date.now()) {
  const hits = new Map() // ip -> number[] (ms timestamps within window)
  return {
    /** @returns {ok, retryAfterMs} */
    take(ip) {
      const now = clock()
      const limit = limitsFn()
      const windowMs = 60_000
      let arr = hits.get(ip)
      if (!arr) { arr = []; hits.set(ip, arr) }
      const fresh = arr.filter((t) => now - t < windowMs)
      if (fresh.length >= limit) {
        hits.set(ip, fresh)
        return { ok: false, retryAfterMs: Math.max(50, windowMs - (now - fresh[0])) }
      }
      fresh.push(now)
      hits.set(ip, fresh)
      if (hits.size > 4096) {
        for (const [k, v] of hits) { if (now - (v[v.length - 1] ?? 0) >= windowMs) hits.delete(k) }
      }
      return { ok: true, retryAfterMs: 0 }
    },
  }
}

export const __security = { COOKIE_PREFIX }
