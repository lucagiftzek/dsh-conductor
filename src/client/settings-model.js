/**
 * Settings form model (pure): the copy of every switch and the PUT /settings
 * patch built from the edited form. Mirrors lib/core.js sanitizeSettingsPatch,
 * which bounds and validates everything again on the host.
 */

export const MODULES = [
  ['context', 'Context tools', '/new, /clear, /drop, the Context sub-tab and resets in History.'],
  ['pins', 'Pins', 'Pinned messages stay in the context across every reset.'],
  ['posts', 'Silent posts and inbox', 'Other chats and scripts can leave messages without waking this one.'],
  ['versions', 'Message versions', 'Edit what the model sees of a message; every version is kept.'],
  ['orchestration', 'Agents and tasks', 'Spawn and prompt chats, run tasks on runners, provider cards.'],
]

export const TOOLS = [
  ['chat', 'chat tool', 'Lets the model manage its own context: drop, pin, edit, reset.'],
  ['chats', 'chats tool', 'Lets the model list, prompt and post to other chats.'],
  ['tasks', 'tasks tool', 'Lets the model run and read background tasks.'],
  ['legacy', 'Legacy orch_* tools', 'The dsh-orchestrator tool names, for old prompts. Off by default.'],
]

/** Recovery settings: [key, title, description, kind]. */
export const RECOVERY_FIELDS = [
  ['enabled', 'Recover chats automatically', 'Resume a chat after a failed, cut-off or crashed turn.', 'bool'],
  ['maxAttempts', 'Attempts per incident', 'Retries before it gives up and leaves a ghost saying so.', 'num'],
  ['baseDelayMs', 'First wait (seconds)', 'Doubles with each attempt; a Retry-After from the provider wins.', 'sec'],
  ['maxDelayMs', 'Longest wait (seconds)', '', 'sec'],
  ['hourlyCap', 'Attempts per hour, all chats', 'A safety cap against loops.', 'num'],
  ['continueTruncated', 'Continue answers cut off at the length limit', '', 'bool'],
  ['overflow', 'When the context is too full', 'Hand off to a fresh context, or stop.', 'overflow'],
  ['resumeCrashed', 'Resume turns cut by a server restart', '', 'bool'],
  ['crashWindowMinutes', 'Only if the restart is this recent (minutes)', '', 'num'],
  ['fallbackAfter', 'Switch to the fallback model after (attempts)', '', 'num'],
  ['resumeText', 'Text sent to resume', 'Empty: Conductor’s own wording.', 'text'],
]

export const MODEL_MAY = [
  ['drop', 'Drop items from its context'],
  ['edit', 'Edit its own answers'],
  ['pin', 'Pin messages'],
  ['new', 'Start a fresh context with /new (runs after its turn)'],
  ['compact', 'Compact its context'],
  ['clear', 'Clear its context (off by default)'],
  ['post', 'Post silent messages to other chats'],
  ['prompt', 'Prompt other chats'],
  ['spawn', 'Spawn agents'],
  ['cancel', 'Cancel other chats'],
]

const pickBools = (src, keys) => {
  const out = {}
  for (const [k] of keys) if (src && typeof src[k] === 'boolean') out[k] = src[k]
  return out
}

/** The PUT /settings body for an edited form (the GET /settings `settings` object, edited). */
export function buildSettingsPatch(form) {
  const patch = buildFullPatch(form)
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k]
  return patch
}

function buildFullPatch(form) {
  const f = form || {}
  const a = f.agents || {}
  const t = f.tasks || {}
  return {
    enabled: f.enabled,
    mirrorJobs: f.mirrorJobs,
    requireHarnessCookie: f.requireHarnessCookie,
    trustedHosts: f.trustedHosts,
    api: { rateLimitPerMinute: f.api && f.api.rateLimitPerMinute },
    agents: {
      catalogMax: a.catalogMax,
      transcriptMax: a.transcriptMax,
      spawnMax: a.spawnMax,
      promptMaxChars: a.promptMaxChars,
      defaultPreset: a.defaultPreset,
      defaultCwd: a.defaultCwd,
    },
    tasks: {
      maxConcurrent: t.maxConcurrent,
      historyKeep: t.historyKeep,
      commandTimeoutMs: t.commandTimeoutMs,
      scrapeTimeoutMs: t.scrapeTimeoutMs,
      httpTimeoutMs: t.httpTimeoutMs,
      scrapeMaxUrls: t.scrapeMaxUrls,
      defaultRunner: t.defaultRunner,
      allowCommandTasks: t.allowCommandTasks,
      allowRemoteRunners: t.allowRemoteRunners,
    },
    runners: f.runners,
    providers: f.providers,
    modules: pickBools(f.modules, MODULES),
    tools: pickBools(f.tools, TOOLS),
    modelMay: pickBools(f.modelMay, MODEL_MAY),
    handoffDir: typeof f.handoffDir === 'string' ? f.handoffDir.trim() : '',
    posts: { maxChars: f.posts && f.posts.maxChars, chatRow: !(f.posts && f.posts.chatRow === false) },
    resetTimeoutMs: f.resetTimeoutMs,
    autoCompact: f.autoCompact ? { percent: Number(f.autoCompact.percent) || 0, action: f.autoCompact.action === 'handoff' ? 'handoff' : 'compact', nudge: f.autoCompact.nudge !== false } : undefined,
    recovery: f.recovery ? { ...f.recovery } : undefined,
    handoffTemplate: typeof f.handoffTemplate === 'string' ? f.handoffTemplate : undefined,
  }
}

/** Immutable set of a nested path. */
export function setPath(obj, path, value) {
  const next = Array.isArray(obj) ? [...obj] : { ...(obj || {}) }
  const [head, ...rest] = path
  next[head] = rest.length ? setPath(next[head], rest, value) : value
  return next
}

export function getPath(obj, path) {
  return path.reduce((acc, k) => (acc === null || acc === undefined ? acc : acc[k]), obj)
}
