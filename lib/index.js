/**
 * dsh-conductor - host half entry.
 *
 * Wires, in order:
 *   1. the settings store      (Settings -> Orchestrator). DSH 0.1.5: the
 *      registered namespace `dsh-conductor` in settings.yaml. DSH 0.2.x: the
 *      `dsh-conductor` row of the profile's cordis.patch.yml (every field of
 *      the exported `Config` is live except stateDir), imported once from
 *      settings.yaml(.imported) while the row is still empty. Both through
 *      lib/dual-settings.js. JSON-file fallback when no settings service or
 *      schemastery exists (the plugin still boots - a throwing plugin entry
 *      takes the whole app down on this profile, learned the hard way).
 *   2. the task engine         (durable store under ~/.dsh/dsh-conductor).
 *   3. the API route           /dsh-conductor/api (browser + machine).
 *   4. the agent tools         orch_* (15 of them), registered only when
 *      defineTool resolves defensively from this package's location.
 *   5. the jobs mirror lookup  (best-effort ctx.jobs).
 *
 * WHY NO @deepseek-ai/* STATIC IMPORTS: they drift between releases and a
 * failed static import is a boot-killing SyntaxError, not a degradation.
 * Everything optional is resolved through ctx.get() at apply() time and
 * every seam degrades to an honest error row.
 *
 * KILL SWITCH: DSH_CONDUCTOR_DISABLE=1 in the dsh-web environment, or
 *   - id: dsh-conductor
 *     disabled: true
 * in the profile's cordis.patch.yml + restart.
 */

'use strict'

import fs from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { createDualSettings, loadHostSchemastery, liveObject, plain } from './dual-settings.js'
import {
  PLUGIN_ID, SETTINGS_NS, API_PREFIX, VERSION, DISABLE_ENV, TOOLS_ENV, SECRET_ENV,
  DEFAULTS, resolveConfig, sanitizeSettingsPatch, dshHomeDir,
} from './core.js'
import { TaskStore } from './store.js'
import { TaskEngine } from './tasks.js'
import { makeAgents } from './agents.js'
import { Providers } from './providers.js'
import { makeHandler } from './api.js'
import { createConductor } from './conductor/service.js'
import { registerCommands } from './conductor/commands.js'
import { conductorTools } from './conductor/tools.js'
import { makeConductorRoute } from './conductor/routes.js'
import { createAutomation } from './conductor/automation.js'
import { createRecovery, RECOVERY_DEFAULTS } from './conductor/recovery.js'
import { createCheckpoints } from './conductor/checkpoints.js'

export const name = 'dsh-conductor'

/** The npm package name (dsh-conductor in a checkout, @lucagiftzek/dsh-conductor from npm). */
const PACKAGE_NAME = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name || 'dsh-conductor' } catch { return 'dsh-conductor' }
})()

/** Minimal static inject: the proven trio plus commands; everything else via ctx.get(). */
export const inject = ['agents', 'settings', 'webServer', 'commands']

function dshHome() {
  return dshHomeDir()
}

// ── schemastery (defensive) ─────────────────────────────────────────────────

// The RUNNING harness's schemastery: on 0.2.x only its copy wraps live fields
// the way the Loader commits them (see lib/dual-settings.js).
function loadSchemastery() { return loadHostSchemastery(import.meta.url) }

function settingsSchema(z) {
  if (!z) return null
  const secret = (f) => (typeof f.role === 'function' ? f.role('secret') : f)
  // Every field is live (read at the moment of use, applied without a
  // remount) except stateDir, a host-level fact that stays plain row config.
  return liveObject(z, {
    stateDir: z.string().default(''),
    enabled: z.boolean().default(DEFAULTS.enabled),
    mirrorJobs: z.boolean().default(DEFAULTS.mirrorJobs),
    requireHarnessCookie: z.boolean().default(DEFAULTS.requireHarnessCookie),
    trustedHosts: z.array(z.string()).default([]),
    api: z.object({
      rateLimitPerMinute: z.number().min(1).default(DEFAULTS.api.rateLimitPerMinute),
      secret: secret(z.string().default('')),
    }).default({ rateLimitPerMinute: DEFAULTS.api.rateLimitPerMinute, secret: '' }),
    agents: z.object({
      catalogMax: z.number().min(10).default(DEFAULTS.agents.catalogMax),
      catalogTtlMs: z.number().min(0).default(DEFAULTS.agents.catalogTtlMs),
      transcriptTailChars: z.number().min(0).default(DEFAULTS.agents.transcriptTailChars),
      transcriptMax: z.number().min(5).default(DEFAULTS.agents.transcriptMax),
      spawnMax: z.number().min(1).default(DEFAULTS.agents.spawnMax),
      promptMaxChars: z.number().min(100).default(DEFAULTS.agents.promptMaxChars),
      defaultPreset: z.string().default(''),
      defaultCwd: z.string().default(''),
    }).default({ ...DEFAULTS.agents }),
    tasks: z.object({
      maxConcurrent: z.number().min(1).default(DEFAULTS.tasks.maxConcurrent),
      maxOutputBytes: z.number().min(1024).default(DEFAULTS.tasks.maxOutputBytes),
      historyKeep: z.number().min(10).default(DEFAULTS.tasks.historyKeep),
      historyPruneSeconds: z.number().min(0).default(DEFAULTS.tasks.historyPruneSeconds),
      commandTimeoutMs: z.number().min(500).default(DEFAULTS.tasks.commandTimeoutMs),
      scrapeTimeoutMs: z.number().min(500).default(DEFAULTS.tasks.scrapeTimeoutMs),
      httpTimeoutMs: z.number().min(500).default(DEFAULTS.tasks.httpTimeoutMs),
      scrapeMaxUrls: z.number().min(1).default(DEFAULTS.tasks.scrapeMaxUrls),
      scrapeMaxBytes: z.number().min(1024).default(DEFAULTS.tasks.scrapeMaxBytes),
      defaultRunner: z.string().default(DEFAULTS.tasks.defaultRunner),
      allowCommandTasks: z.boolean().default(true),
      allowRemoteRunners: z.boolean().default(true),
      pollMs: z.number().min(500).default(DEFAULTS.tasks.pollMs),
    }).default({ ...DEFAULTS.tasks }),
    runners: z.array(z.object({
      id: z.string(),
      label: z.string().default(''),
      kind: z.string().default('local'),
      enabled: z.boolean().default(true),
      ssh: z.object({
        target: z.string(),
        bin: z.string().default('ssh'),
        connectTimeoutMs: z.number().default(10000),
        extraArgs: z.array(z.string()).default([]),
      }).default(undefined),
      http: z.object({
        url: z.string(),
        method: z.string().default('POST'),
        timeoutMs: z.number().default(30000),
        secretEnv: z.string().default(''),
      }).default(undefined),
    })).default(DEFAULTS.runners),
    providers: z.array(z.object({
      id: z.string(),
      label: z.string().default(''),
      kind: z.string().default('http'),
      url: z.string(),
      enabled: z.boolean().default(true),
      pollSeconds: z.number().default(60),
      secretEnv: z.string().default(''),
    })).default([]),
    // ── conductor ──
    modules: boolObject(z, DEFAULTS.modules),
    tools: boolObject(z, DEFAULTS.tools),
    modelMay: boolObject(z, DEFAULTS.modelMay),
    handoffDir: z.string().default(''),
    posts: z.object({
      maxChars: z.number().min(500).default(DEFAULTS.posts.maxChars),
      chatRow: z.boolean().default(DEFAULTS.posts.chatRow),
    }).default({ ...DEFAULTS.posts }),
    resetTimeoutMs: z.number().min(60000).default(DEFAULTS.resetTimeoutMs),
    compact: (typeof z.any === 'function' ? z.any() : z.object({})).default({}),
    legacyRoute: z.boolean().default(false),
    setupCompleted: z.string().default(''),
    handoffTemplate: z.string().default(''),
    recovery: z.object(Object.fromEntries(Object.entries(RECOVERY_DEFAULTS).map(([k, d]) => [k, (typeof d === 'boolean' ? z.boolean() : typeof d === 'number' ? z.number() : z.string()).default(d)]))).default({ ...RECOVERY_DEFAULTS }),
    autoCompact: z.object({
      percent: z.number().min(0).max(95).default(0),
      action: z.string().default('compact'),
      nudge: z.boolean().default(true),
    }).default({ percent: 0, action: 'compact', nudge: true }),
  }, { fixed: ['stateDir', 'compact', 'legacyRoute'] })
}

function boolObject(z, defaults) {
  const shape = {}
  for (const [key, value] of Object.entries(defaults)) shape[key] = z.boolean().default(value)
  return z.object(shape).default({ ...defaults })
}

/** Settings schema as the plugin's Config (0.2.x forms and row validation). */
export const Config = settingsSchema(loadSchemastery()) || undefined

// ── defineTool (defensive) ──────────────────────────────────────────────────

export function resolveDefineTool(env = process.env, log = () => {}) {
  const bases = []
  if (env[TOOLS_ENV]) bases.push(env[TOOLS_ENV])
  bases.push(import.meta.url)
  if (env.DSH_PROFILE) bases.push(join(dshHome(), 'profiles', env.DSH_PROFILE, 'probe.js'))
  bases.push(join(dshHome(), 'profiles', 'web', 'probe.js'))
  bases.push(join(dshHome(), 'profiles', 'probe.js'))
  bases.push(join(dshHome(), 'probe.js'))
  if (process.argv && process.argv[1]) bases.push(process.argv[1])
  for (const base of bases) {
    try {
      const req = createRequire(base)
      const mod = req('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') { log('defineTool resolved via ' + String(base)); return fn }
    } catch { /* next seed */ }
  }
  return null
}

// ── apply ───────────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const log = (m) => console.log('dsh-conductor: ' + m)
  const warn = (m) => console.error('dsh-conductor: ' + m)

  if (process.env[DISABLE_ENV] === '1') {
    log(DISABLE_ENV + '=1 - armed off, nothing registered')
    return
  }

  const pluginDir = join(dshHome(), 'dsh-conductor')
  const fallbackSettingsFile = join(pluginDir, 'settings.json')

  // ── settings store ────────────────────────────────────────────────────
  // 0.1.5: registered namespace. 0.2.x: the row's live Config (the row IS the
  // settings). No service or no schemastery: JSON file fallback, as always.
  const schema = Config || null
  const settingsStore = createDualSettings(ctx, config, {
    ns: SETTINGS_NS,
    packageName: PACKAGE_NAME,
    schema,
    // stateDir is a host-level fact: resolve it against DSH_HOME at apply
    // time (the import-time default would freeze the wrong value under a
    // relocated DSH_HOME, like a sandbox boot).
    base: { ...structuredCloneSafe(DEFAULTS), stateDir: join(dshHome(), 'dsh-conductor') },
    // The plugin ships its own Settings -> Orchestrator section (talks to the
    // route below), so no generated form next to it.
    autoForm: false,
    log, warn, metaUrl: import.meta.url,
  })
  log('settings store: ' + settingsStore.mode + (settingsStore.entryId ? ' (entry ' + settingsStore.entryId + ')' : ''))
  const useFallbackFile = settingsStore.mode === 'config'
  let settingsOverrides = {}
  let fallbackSettings = {}
  if (useFallbackFile) {
    try {
      fallbackSettings = JSON.parse(fs.readFileSync(fallbackSettingsFile, 'utf8'))
    } catch { fallbackSettings = {} }
    warn('settings service unavailable - using the JSON fallback at ' + fallbackSettingsFile)
  }

  function structuredCloneSafe(v) {
    try { return structuredClone(v) } catch { return JSON.parse(JSON.stringify(v)) }
  }

  // Schema defaults, to tell a row value the operator wrote from one the
  // Loader filled in (a plugin with a Config export gets every key defaulted
  // in apply(), on 0.1.5 as well as on 0.2.x).
  const schemaDefaults = (() => {
    if (!schema) return null
    try { return plain(schema({})) } catch { return null }
  })()
  function declaredRow(row) {
    if (!row || typeof row !== 'object' || !schemaDefaults) return row
    const out = {}
    for (const [k, v] of Object.entries(plain(row))) {
      if (k in schemaDefaults && JSON.stringify(v) === JSON.stringify(schemaDefaults[k])) continue
      out[k] = v
    }
    return out
  }

  function effective() {
    // 0.2.x: the row IS the settings, so the row layer is already inside
    // settingsStore.get(); merging it again would double-apply it.
    if (settingsStore.mode === 'forms') return resolveConfig(settingsStore.get() || {})
    let raw = {}
    if (settingsStore.mode === 'register') {
      try { raw = settingsStore.get() || {} } catch { raw = {} }
    } else {
      raw = { ...fallbackSettings, ...settingsOverrides }
    }
    // composition order: cordis row config < settings namespace
    return resolveConfig({ ...raw, ...mergeRowConfig(raw, declaredRow(config)) })
  }

  /**
   * The cordis row config is the deployment floor: anything it declares that
   * the settings namespace left untouched applies; keys the operator moved
   * into settings win. stateDir and trustedHosts are host-level facts, so
   * the row wins there.
   */
  function mergeRowConfig(current, row) {
    const out = {}
    if (!row || typeof row !== 'object') return out
    for (const [k, v] of Object.entries(row)) {
      if (k === 'stateDir' || k === 'trustedHosts') { out[k] = v; continue }
      if (current[k] === undefined) out[k] = v
    }
    if (row.runners && Array.isArray(row.runners) && !Array.isArray(current.runners)) out.runners = row.runners
    if (row.providers && Array.isArray(row.providers) && !Array.isArray(current.providers)) out.providers = row.providers
    return out
  }

  async function persistSettingsPatch(patch) {
    if (!useFallbackFile) {
      if (!settingsStore.writable()) throw new Error('settings not writable: no loader row for this plugin')
      await settingsStore.update(patch)
      return 'settings'
    }
    const merged = { ...fallbackSettings, ...settingsOverrides, ...patch }
    Object.assign(settingsOverrides, patch)
    fallbackSettings = merged
    fs.mkdirSync(pluginDir, { recursive: true })
    const tmp = fallbackSettingsFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + String.fromCharCode(10), { mode: 0o600 })
    fs.renameSync(tmp, fallbackSettingsFile)
    return 'fallback-file'
  }

  // ── engine + facades ───────────────────────────────────────────────────
  // Facades take config GETTERS so every read observes live settings; the
  // engine gets a reference it re-reads through this.cfg on each method call.
  const cfgRef = () => effective()
  const cfg = cfgRef()
  const store = new TaskStore(cfg.stateDir)
  const agents = makeAgents(ctx, cfgRef, { log, warn })
  const providers = new Providers(cfgRef, { log })
  const engine = new TaskEngine(cfg, store, agents, { log, warn })
  engine.setJobsLookup(() => {
    try { return ctx.get('jobs') || null } catch { return null }
  })

  // Re-resolve the engine's config reference whenever settings change so
  // limits and runner lists apply live (agents/providers already read
  // through the getter).
  function refreshFacades() {
    engine.cfg = effective()
    engine.runners = () => engine.cfg.runners
  }
  if (!useFallbackFile) {
    try { ctx.effect(() => settingsStore.watch(() => refreshFacades()), 'dsh-conductor: settings watcher') } catch { /* optional */ }
  }

  void engine.boot().then(() => {
    log('engine booted - ' + engine.list({ limit: 5000 }).length + ' task(s) in history')
  }).catch((e) => warn('engine boot: ' + (e && e.message || e)))

  // ── conductor: context, pins, versions, posts ─────────────────────────
  const modules = cfg.modules
  const conductor = createConductor(ctx, {
    cfg: effective,
    stateDir: cfg.stateDir,
    agents,
    log: (m) => log(m),
    warn: (m) => warn(m),
  })
  if (modules.context !== false) ctx.effect(() => conductor.install(), 'dsh-conductor: compaction hook')
  const automation = createAutomation(ctx, conductor, { log, warn })
  conductor.automation = automation
  const recovery = createRecovery(ctx, conductor, { cfg: effective, log, warn, agents })
  conductor.recovery = recovery
  const checkpoints = createCheckpoints(ctx, conductor, { stateDir: cfg.stateDir, log, warn })
  conductor.checkpoints = checkpoints
  if (modules.context !== false) ctx.effect(() => checkpoints.install(), 'dsh-conductor: checkpoints')
  ctx.effect(() => () => recovery.dispose(), 'dsh-conductor: recovery timers')
  if (typeof ctx.on === 'function') ctx.on('agent/request', (payload, next) => recovery.requestHook(payload, next))
  {
    const bootTimer = setTimeout(() => { void recovery.bootScan().catch((e) => warn('recovery boot scan: ' + (e && e.message || e))) }, 15000)
    bootTimer.unref?.()
    ctx.effect(() => () => clearTimeout(bootTimer), 'dsh-conductor: recovery boot scan')
  }
  if (modules.context !== false) ctx.effect(() => automation.start(), 'dsh-conductor: automation timer')
  ctx.effect(() => () => conductor.store.flush(), 'dsh-conductor: store flush')
  const commandEnabled = (name) => {
    const m = effective().modules
    if (['new', 'clear', 'force-compact', 'context', 'drop', 'undrop'].includes(name)) return m.context !== false
    if (name === 'pin' || name === 'unpin') return m.pins !== false
    if (name === 'post') return m.posts !== false
    return true
  }
  const skippedCommands = ctx.commands && typeof ctx.commands.register === 'function'
    ? registerCommands(ctx, conductor, { log, warn, enabled: commandEnabled })
    : (warn('the commands registry is unavailable: no slash commands'), [])
  if (skippedCommands.length) warn('some commands belong to another plugin (remove dsh-force-compact / dsh-orchestrator from the profile): ' + skippedCommands.join(', '))
  // Model actions during its own turn land before its next step, never inside a tool call.
  if (typeof ctx.on === 'function') ctx.on('agent/pre-step', async ({ agent }, next) => {
    try { if (conductor.hasPending(agent?.session?.id)) await conductor.runPending(agent) } catch (e) { warn('pre-step: ' + (e && e.message || e)) }
    try { await conductor.preStepNudge(agent) } catch (e) { warn('pre-step nudge: ' + (e && e.message || e)) }
    return next()
  })
  if (typeof ctx.on === 'function') ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') {
      void conductor.onIdle(agent).catch((e) => warn('after-turn reset: ' + (e && e.message || e)))
      void automation.onIdle(agent).catch((e) => warn('scheduled /new: ' + (e && e.message || e)))
      void recovery.onIdle(agent).catch((e) => warn('recovery: ' + (e && e.message || e)))
    } else if (status === 'running') {
      recovery.onRunning(agent)
    }
  })

  // ── the route ─────────────────────────────────────────────────────────
  const handler = makeHandler(cfg, {
    engine,
    agents,
    providers,
    effective,
    persistSettingsPatch,
    settingsStore: useFallbackFile ? 'fallback-file' : 'settings',
    conductorRoute: makeConductorRoute(ctx, conductor, { warn }),
    log,
    warn,
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'dsh-conductor: api route')
  if (cfg.legacyRoute) {
    try {
      ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-orchestrator/api', handler }), 'dsh-conductor: legacy api route')
      log('legacy route /dsh-orchestrator/api served too')
    } catch (e) {
      warn('legacy route /dsh-orchestrator/api not registered (is dsh-orchestrator still mounted?): ' + (e && e.message || e))
    }
  }

  // ── the tools ─────────────────────────────────────────────────────────
  // The tools registry is read through ctx.get() at apply time, NOT a static
  // inject entry: a static entry would hold activation hostage to the
  // registry (the dsh-tools maintainers' own advice for optional services),
  // while a missing registry here degrades to an honest warning.
  const toolsService = (() => { try { return ctx.get('tools') || null } catch { return null } })()
  const defineTool = resolveDefineTool(process.env, log)
  if (typeof defineTool !== 'function') {
    warn('@deepseek-ai/dsh-tools could not be resolved from this package location, so NO tools were registered. The route and the sidebar still work. Fix: install the plugin so its realpath sits under ~/.dsh/profiles, or set ' + TOOLS_ENV + ' to the dsh-tools entrypoint.')
  } else if (!toolsService || typeof toolsService.register !== 'function') {
    warn('the ctx.tools registry is unavailable in this composition, so NO tools were registered. The route and the sidebar still work.')
  } else {
    let registered = 0
    try {
      const toolSwitches = { ...cfg.tools }
      if (modules.orchestration === false) { toolSwitches.chats = false; toolSwitches.tasks = false; toolSwitches.legacy = false }
      if (modules.context === false && modules.pins === false && modules.versions === false) toolSwitches.chat = false
      for (const def of conductorTools(defineTool, {
        conductor,
        engine, agents, providers,
        cfg: new Proxy({}, { get: (_t, k) => effective()[k] }),
        policy: () => effective().modelMay,
        probeRunners: (r) => import('./runners.js').then((m) => m.probeRunner(r)),
        sessionController: () => { try { return ctx.get('sessionController') || null } catch { return null } },
      }, { tools: toolSwitches })) {
        ctx.effect(() => {
          const dispose = toolsService.register(def)
          return () => { try { if (typeof dispose === 'function') dispose() } catch { /* gone */ } }
        }, 'dsh-conductor: tool ' + def.name)
        registered += 1
      }
    } catch (e) {
      warn('tool registration failed: ' + ((e && e.stack) || e))
    }
    log('armed - ' + registered + ' agent tool(s), route ' + API_PREFIX + ', state ' + cfg.stateDir + ', settings ' + (useFallbackFile ? 'fallback-file' : SETTINGS_NS + '/' + settingsStore.mode) + (machineSecretPresent() ? ', machine API: secret configured' : ', machine API: fail-closed (no secret)'))
  }

  function machineSecretPresent() {
    return Boolean((process.env[SECRET_ENV] || '').trim() || effective().api.secret)
  }

  // Prune finished history periodically (cheap; failures are logged once).
  const pruneTimer = setInterval(() => {
    try {
      const c = effective()
      const dropped = store.prune(c.tasks.historyKeep, c.tasks.historyPruneSeconds)
      if (dropped) void store.flush().catch(() => {})
      if (!c.enabled) return
    } catch { /* best effort */ }
  }, 10 * 60 * 1000)
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref()
  ctx.effect(() => () => clearInterval(pruneTimer), 'dsh-conductor: prune timer')
}

export const __index = { loadSchemastery, settingsSchema, resolveDefineTool }
