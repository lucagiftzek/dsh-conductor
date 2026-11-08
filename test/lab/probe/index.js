/**
 * conductor-lab-probe: LAB ONLY HTTP driver for dsh-conductor end-to-end tests.
 *
 * Mounted only in the isolated lab profile (DSH_HOME=~/dsh-lab). It lets the
 * e2e script create chats, send prompts, run slash commands and read the raw
 * session log and surface over plain HTTP, so every behaviour can be asserted
 * without a browser. Guarded by a header token (LAB_PROBE_TOKEN env var).
 */
import { randomUUID } from 'node:crypto'

export const name = 'conductor-lab-probe'
export const inject = ['agents', 'commands', 'webServer']

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const textOf = (content) => (Array.isArray(content) ? content.map((b) => (b?.type === 'text' ? b.text : `[${b?.type}]`)).join('') : '')

export function apply(ctx) {
  const token = process.env.LAB_PROBE_TOKEN || 'lab'
  const controller = () => ctx.get('sessionController')

  async function agentFor(sessionId) {
    let agent = ctx.agents.get(sessionId)
    let resolveError
    if (!agent) {
      try { await controller().resolveAgent(sessionId) } catch (error) { resolveError = error }
      agent = ctx.agents.get(sessionId)
    }
    if (!agent) {
      // surface the real reason (resolveAgent may swallow it)
      try {
        const handle = await ctx.agents.resume({ resumeSessionId: sessionId })
        agent = ctx.agents.get(sessionId) ?? handle?.agent
      } catch (error) {
        throw new Error(`no agent for ${sessionId}: resolve=${resolveError?.message ?? 'ok'} resume=${error?.stack || error}`)
      }
    }
    if (!agent) throw new Error(`no agent for ${sessionId} (resolve=${resolveError?.message ?? 'ok'})`)
    return agent
  }

  async function waitIdle(sessionId, timeoutMs = 60000) {
    const start = Date.now()
    let idleStreak = 0
    await sleep(150)
    while (Date.now() - start < timeoutMs) {
      const agent = ctx.agents.get(sessionId)
      if (agent && agent.status === 'idle') {
        idleStreak += 1
        if (idleStreak >= 4) return true
      } else idleStreak = 0
      await sleep(150)
    }
    return false
  }

  function describe(session) {
    const nodes = session.surface.nodes.map((seq) => {
      const event = session.eventAt(seq)
      const message = event?.data?.message ?? event?.data
      return {
        seq: Number(seq),
        type: event?.type,
        role: message?.role,
        source: message?.source?.kind,
        chars: JSON.stringify(message?.content ?? '').length,
        text: textOf(message?.content).slice(0, 300),
      }
    })
    let tokens
    try { tokens = ctx.get('tokenMeter')?.measure(session)?.totalTokens } catch { tokens = undefined }
    return { id: session.id, nodes, tokens, events: session.snapshotEvents().length }
  }

  const handler = async (req, res) => {
    try {
      if (req.headers['x-lab-token'] !== token) return json(res, 401, { error: 'token' })
      const url = new URL(req.url, 'http://lab')
      const path = url.pathname.replace(/^\/lab-probe\/api/, '')
      if (req.method === 'POST' && path === '/create') {
        const body = await readBody(req)
        const created = await controller().create({ cwd: body.cwd || process.env.HOME, ...(body.agentPreset ? { agentPreset: body.agentPreset } : {}) })
        await agentFor(created.sessionId)
        return json(res, 200, created)
      }
      if (req.method === 'POST' && path === '/prompt') {
        const body = await readBody(req)
        await agentFor(body.sessionId)
        await controller().prompt({ requestId: randomUUID(), sessionId: body.sessionId, mode: 'queue', content: [{ type: 'text', text: String(body.text) }] }, AbortSignal.timeout(30000))
        const idle = body.wait === false ? null : await waitIdle(body.sessionId, body.timeoutMs)
        return json(res, 200, { accepted: true, idle })
      }
      if (req.method === 'POST' && path === '/command') {
        const body = await readBody(req)
        const agent = await agentFor(body.sessionId)
        const out = await ctx.commands.execute(agent, String(body.line), [], AbortSignal.timeout(body.timeoutMs || 120000))
        if (body.wait !== false) await waitIdle(body.sessionId, body.timeoutMs)
        return json(res, 200, { result: out?.result ?? out ?? null })
      }
      if (req.method === 'POST' && path === '/select') {
        // route one chat to another model (e.g. the local ollama provider for a real-model smoke test)
        const body = await readBody(req)
        await agentFor(body.sessionId)
        const out = await controller().selectModel({ sessionId: body.sessionId, provider: body.provider, model: body.model, ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}) })
        return json(res, 200, out)
      }
      if (req.method === 'POST' && path === '/wait') {
        const body = await readBody(req)
        return json(res, 200, { idle: await waitIdle(body.sessionId, body.timeoutMs) })
      }
      if (req.method === 'GET' && path === '/verify') {
        // Decode the STORED log exactly as a cold load does (format + surface validation).
        const sessionId = url.searchParams.get('sessionId')
        const live = ctx.agents.get(sessionId)?.session
        if (live) await ctx.get('sessions').flush(live)
        const persistence = ctx.get('sessionPersistence')
        let handle
        try {
          handle = await persistence.open(sessionId, 'read')
          const { events } = await handle.read()
          return json(res, 200, { ok: true, events: events.length })
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message || error).slice(0, 600) })
        } finally {
          await handle?.close?.().catch?.(() => {})
        }
      }
      if (req.method === 'GET' && path === '/state') {
        const agent = await agentFor(url.searchParams.get('sessionId'))
        return json(res, 200, { status: agent.status, ...describe(agent.session) })
      }
      if (req.method === 'GET' && path === '/events') {
        const agent = await agentFor(url.searchParams.get('sessionId'))
        const from = Number(url.searchParams.get('from') || 0)
        const events = agent.session.snapshotEvents(from).map((e) => ({
          seq: Number(e.seq),
          type: e.type,
          surfaceOp: e.surfaceOp,
          sourceEventSeqs: e.sourceEventSeqs?.map(Number),
          ignorable: e.ignorable,
          role: e.data?.message?.role ?? e.data?.role,
          source: e.data?.message?.source?.kind ?? e.data?.source?.kind,
          text: textOf(e.data?.message?.content ?? e.data?.content).slice(0, 500),
        }))
        return json(res, 200, { events })
      }
      return json(res, 404, { error: 'not found' })
    } catch (error) {
      return json(res, 500, { error: String(error?.stack || error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/lab-probe/api', handler }), 'lab probe route')
  console.log('conductor-lab-probe: armed (LAB ONLY)')
}
