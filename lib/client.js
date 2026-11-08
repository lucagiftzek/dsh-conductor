window.__ModuleLoader__.load({ id: "@lucagiftzek/dsh-conductor", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.jsx
var index_exports = {};
__export(index_exports, {
  SECTION_COMMANDS: () => SECTION_COMMANDS,
  apply: () => apply,
  inject: () => inject,
  name: () => name,
  openSection: () => openSection,
  tabDescriptor: () => tabDescriptor
});
module.exports = __toCommonJS(index_exports);
var import_react16 = __toESM(require("react"), 1);

// src/client/tab.jsx
var import_react13 = __toESM(require("react"), 1);

// src/client/api.js
var PLUGIN_ID = "dsh-conductor";
var API = "/" + PLUGIN_ID + "/api";
var ApiError = class extends Error {
  constructor(message, status, code, offline) {
    super(message);
    this.status = status;
    this.code = code;
    this.offline = Boolean(offline);
  }
};
async function parse(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || body && body.ok === false) {
    const offline = !body && (response.status === 404 || response.status === 502 || response.status === 503 || response.status === 504);
    const message = body && (body.error || body.text) || (offline ? "Conductor service unreachable" : "HTTP " + response.status);
    throw new ApiError(String(message), response.status, body && body.code, offline);
  }
  return body || {};
}
function networkError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError(String(error && error.message || error || "network error"), 0, "network", true);
}
function getJson(path) {
  return fetch(API + path, { credentials: "same-origin", headers: { accept: "application/json" } }).then(parse, (e) => {
    throw networkError(e);
  });
}
function mutate(method, path, body) {
  return fetch(API + path, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json", "x-requested-with": PLUGIN_ID },
    body: JSON.stringify(body || {})
  }).then(parse, (e) => {
    throw networkError(e);
  });
}
var post = (path, body) => mutate("POST", path, body);
var enc = encodeURIComponent;
function sessionApi(sessionId) {
  const base = "/conductor/session/" + enc(sessionId);
  return {
    /** The whole view, or { unchanged: true, fingerprint } when `since` still matches. */
    view: (since) => getJson(base + (since ? "?since=" + enc(since) : "")),
    item: (seq2) => getJson(base + "/item/" + enc(seq2)),
    reset: (kind, focus) => post(base + "/reset", focus ? { kind, focus } : { kind }),
    /** Abort a running /new, /clear or /force-compact (the context stays unchanged). */
    cancelReset: () => post(base + "/reset/cancel", {}),
    drop: (seqs) => post(base + "/drop", { seqs }),
    undrop: (target) => post(base + "/undrop", { target }),
    pin: (target, note) => post(base + "/pin", note ? { target, note } : { target }),
    unpin: (target) => post(base + "/unpin", { target }),
    /** Edit a pin's note; an empty note removes it. */
    pinNote: (target, note) => post(base + "/pin-note", { target, note: note || "" }),
    edit: (target, text, reason) => post(base + "/edit", reason ? { target, text, reason } : { target, text }),
    restore: (messageId, version) => post(base + "/restore", { messageId, version }),
    inbox: (action, ids) => post(base + "/inbox", ids ? { action, ids } : { action }),
    // automation
    level: (spec) => post(base + "/level", spec),
    autoNew: (spec) => post(base + "/auto-new", spec),
    relay: (to) => post(base + "/relay", { to: to || null }),
    template: (template) => post(base + "/template", { template: template || "" }),
    recovery: (enabled) => post(base + "/recovery", { enabled: Boolean(enabled) }),
    // checkpoints and rewind
    checkpoints: (previewId) => getJson(base + "/checkpoints" + (previewId ? "?preview=" + enc(previewId) : "")),
    checkpoint: (name2) => post(base + "/checkpoint", name2 ? { name: name2 } : {}),
    rewind: (opts) => post(base + "/rewind", opts),
    rewindUndo: () => post(base + "/rewind/undo", {}),
    // search earlier context (archives, drops, handoffs)
    recall: (q, limit = 10) => getJson(base + "/recall?q=" + enc(q) + "&limit=" + enc(limit))
  };
}
function postToChat({ to, text, kind, visible, fromSessionId }) {
  const body = { to, text, kind: kind || "note", visible: visible || "user+model" };
  if (fromSessionId) body.fromSessionId = fromSessionId;
  return post("/conductor/post", body);
}
function errorText(error) {
  return String(error && error.message || error || "Unknown error");
}

// src/client/store.js
function createSignal(initial) {
  let value = initial;
  const listeners = /* @__PURE__ */ new Set();
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch (e) {
          console.warn("[dsh-conductor] listener failed", e);
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}
var EMPTY = Object.freeze({ status: "idle", view: null, error: null, fetchedAt: 0, viewAt: 0 });
var sessions = /* @__PURE__ */ new Map();
function sessionModel(sessionId) {
  let model = sessions.get(sessionId);
  if (model) return model;
  const signal = createSignal(EMPTY);
  let inflight = null;
  model = {
    sessionId,
    subscribe: signal.subscribe,
    getSnapshot: signal.get,
    /** Fetch the view; concurrent callers share one request. */
    refresh() {
      if (inflight) return inflight;
      const before = signal.get();
      if (!before.view) signal.set({ ...before, status: "loading" });
      const since = before.view && before.status === "ready" && !before.view.progress ? before.view.fingerprint : void 0;
      inflight = sessionApi(sessionId).view(since).then((view) => {
        const cur = signal.get();
        const now = Date.now();
        const same = cur.view && cur.status === "ready" && (view.unchanged || cur.view.fingerprint === view.fingerprint && !view.progress && !cur.view.progress);
        if (same) {
          cur.fetchedAt = now;
          return cur.view;
        }
        if (view.unchanged) {
          return sessionApi(sessionId).view().then((full) => {
            signal.set({ status: "ready", view: full, error: null, fetchedAt: Date.now(), viewAt: Date.now() });
            return full;
          });
        }
        signal.set({ status: "ready", view, error: null, fetchedAt: now, viewAt: now });
        return view;
      }, (error) => {
        const cur = signal.get();
        signal.set({ ...cur, status: "error", error, fetchedAt: Date.now() });
        throw error;
      }).finally(() => {
        inflight = null;
      });
      return inflight;
    },
    /** Refresh unless a fetch newer than maxAgeMs exists; never throws. */
    ensure(maxAgeMs = 15e3) {
      const cur = signal.get();
      if (inflight) return inflight.catch(() => null);
      if (cur.view && Date.now() - cur.fetchedAt < maxAgeMs) return Promise.resolve(cur.view);
      return model.refresh().catch(() => null);
    },
    /** Local optimistic patch of the view (cleared by the next refresh). */
    patch(fn) {
      const cur = signal.get();
      if (!cur.view) return;
      signal.set({ ...cur, view: fn(cur.view) });
    }
  };
  sessions.set(sessionId, model);
  return model;
}
var statusModel = createSignal({ status: "idle", data: null, error: null });
var statusInflight = null;
function refreshStatus() {
  if (statusInflight) return statusInflight;
  statusInflight = getJson("/status").then((data) => {
    statusModel.set({ status: "ready", data, error: null });
    return data;
  }, (error) => {
    statusModel.set({ ...statusModel.get(), status: "error", error });
    return null;
  }).finally(() => {
    statusInflight = null;
  });
  return statusInflight;
}
function runningCount() {
  const data = statusModel.get().data;
  if (!data) return 0;
  const agents = data.agents && data.agents.running || 0;
  const tasks = data.tasks && data.tasks.byStatus && data.tasks.byStatus.running || 0;
  return agents + tasks;
}
var settingsModel = createSignal({ status: "idle", data: null, error: null });
var settingsInflight = null;
function refreshSettings() {
  if (settingsInflight) return settingsInflight;
  settingsInflight = getJson("/settings").then((data) => {
    settingsModel.set({ status: "ready", data, error: null });
    return data;
  }, (error) => {
    settingsModel.set({ ...settingsModel.get(), status: "error", error });
    return null;
  }).finally(() => {
    settingsInflight = null;
  });
  return settingsInflight;
}
function moduleOn(name2) {
  const data = settingsModel.get().data;
  const modules = data && data.settings && data.settings.modules;
  return !modules || modules[name2] !== false;
}
var setupRerun = createSignal(false);
function setupNeeded() {
  if (setupRerun.get()) return true;
  const data = settingsModel.get().data;
  return Boolean(data && data.settings && data.settings.setupCompleted === "");
}
var TAB_ID = "dsh-conductor:main";
var prefs = createSignal({});
var PREF_DEFAULTS = Object.freeze({
  autoPoll: true,
  undoSeconds: 10,
  warnPercent: 80,
  inboxBadge: true,
  autoOpenInbox: false
});
function pref(key) {
  const value = prefs.get()[key];
  if (value === void 0 || value === null || value === "") return PREF_DEFAULTS[key];
  if (typeof PREF_DEFAULTS[key] === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : PREF_DEFAULTS[key];
  }
  return value;
}
var requests = createSignal({});
function requestSection(sessionId, section) {
  requests.set({ ...requests.get(), [sessionId || "*"]: { section, at: Date.now() } });
}
function takeRequest(sessionId) {
  const all = requests.get();
  const hit = all[sessionId] || all["*"];
  if (!hit) return null;
  const next = { ...all };
  delete next[sessionId];
  delete next["*"];
  requests.set(next);
  return hit;
}
function badgeFor(sessionId) {
  if (sessionId && pref("inboxBadge") !== false) {
    const model = sessions.get(sessionId);
    const unread = model && model.getSnapshot().view ? Number(model.getSnapshot().view.unread) || 0 : 0;
    if (unread > 0) return unread;
  }
  const running = runningCount();
  return running > 0 ? running : null;
}

// src/client/setup.jsx
var import_react3 = __toESM(require("react"), 1);

// src/client/settings-model.js
var MODULES = [
  ["context", "Context tools", "/new, /clear, /drop, the Context sub-tab and resets in History."],
  ["pins", "Pins", "Pinned messages stay in the context across every reset."],
  ["posts", "Silent posts and inbox", "Other chats and scripts can leave messages without waking this one."],
  ["versions", "Message versions", "Edit what the model sees of a message; every version is kept."],
  ["orchestration", "Agents and tasks", "Spawn and prompt chats, run tasks on runners, provider cards."]
];
var TOOLS = [
  ["chat", "chat tool", "Lets the model manage its own context: drop, pin, edit, reset."],
  ["chats", "chats tool", "Lets the model list, prompt and post to other chats."],
  ["tasks", "tasks tool", "Lets the model run and read background tasks."],
  ["legacy", "Legacy orch_* tools", "The dsh-orchestrator tool names, for old prompts. Off by default."]
];
var RECOVERY_FIELDS = [
  ["enabled", "Recover chats automatically", "Resume a chat after a failed, cut-off or crashed turn.", "bool"],
  ["maxAttempts", "Attempts per incident", "Retries before it gives up and leaves a ghost saying so.", "num"],
  ["baseDelayMs", "First wait (seconds)", "Doubles with each attempt; a Retry-After from the provider wins.", "sec"],
  ["maxDelayMs", "Longest wait (seconds)", "", "sec"],
  ["hourlyCap", "Attempts per hour, all chats", "A safety cap against loops.", "num"],
  ["continueTruncated", "Continue answers cut off at the length limit", "", "bool"],
  ["overflow", "When the context is too full", "Hand off to a fresh context, or stop.", "overflow"],
  ["resumeCrashed", "Resume turns cut by a server restart", "", "bool"],
  ["crashWindowMinutes", "Only if the restart is this recent (minutes)", "", "num"],
  ["fallbackAfter", "Switch to the fallback model after (attempts)", "", "num"],
  ["resumeText", "Text sent to resume", "Empty: Conductor\u2019s own wording.", "text"]
];
var MODEL_MAY = [
  ["drop", "Drop items from its context"],
  ["edit", "Edit its own answers"],
  ["pin", "Pin messages"],
  ["new", "Start a fresh context with /new (runs after its turn)"],
  ["compact", "Compact its context"],
  ["clear", "Clear its context (off by default)"],
  ["post", "Post silent messages to other chats"],
  ["prompt", "Prompt other chats"],
  ["spawn", "Spawn agents"],
  ["cancel", "Cancel other chats"]
];
var pickBools = (src, keys) => {
  const out = {};
  for (const [k] of keys) if (src && typeof src[k] === "boolean") out[k] = src[k];
  return out;
};
function buildSettingsPatch(form) {
  const patch = buildFullPatch(form);
  for (const k of Object.keys(patch)) if (patch[k] === void 0) delete patch[k];
  return patch;
}
function buildFullPatch(form) {
  const f = form || {};
  const a = f.agents || {};
  const t = f.tasks || {};
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
      defaultCwd: a.defaultCwd
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
      allowRemoteRunners: t.allowRemoteRunners
    },
    runners: f.runners,
    providers: f.providers,
    modules: pickBools(f.modules, MODULES),
    tools: pickBools(f.tools, TOOLS),
    modelMay: pickBools(f.modelMay, MODEL_MAY),
    handoffDir: typeof f.handoffDir === "string" ? f.handoffDir.trim() : "",
    posts: { maxChars: f.posts && f.posts.maxChars, chatRow: !(f.posts && f.posts.chatRow === false) },
    resetTimeoutMs: f.resetTimeoutMs,
    autoCompact: f.autoCompact ? { percent: Number(f.autoCompact.percent) || 0, action: f.autoCompact.action === "handoff" ? "handoff" : "compact", nudge: f.autoCompact.nudge !== false } : void 0,
    recovery: f.recovery ? { ...f.recovery } : void 0,
    handoffTemplate: typeof f.handoffTemplate === "string" ? f.handoffTemplate : void 0
  };
}
function setPath(obj, path, value) {
  const next = Array.isArray(obj) ? [...obj] : { ...obj || {} };
  const [head, ...rest] = path;
  next[head] = rest.length ? setPath(next[head], rest, value) : value;
  return next;
}
function getPath(obj, path) {
  return path.reduce((acc, k) => acc === null || acc === void 0 ? acc : acc[k], obj);
}

// src/client/ui.jsx
var import_react = __toESM(require("react"), 1);
function useSignal(signal) {
  const get = signal.getSnapshot || signal.get;
  return (0, import_react.useSyncExternalStore)(signal.subscribe, get, get);
}
function useNow(ms = 1e3, active = true) {
  const [now, setNow] = (0, import_react.useState)(() => Date.now());
  (0, import_react.useEffect)(() => {
    if (!active) return void 0;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return now;
}
function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(String(text)).then(() => true, () => false);
  } catch {
  }
  return Promise.resolve(false);
}
var svg = (size, children, extra) => /* @__PURE__ */ import_react.default.createElement(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.4",
    strokeLinecap: "square",
    strokeLinejoin: "miter",
    "aria-hidden": "true",
    focusable: "false",
    ...extra
  },
  children
);
var Icon = {
  conductor: (size = 16) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M2.5 3.5h11" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M2.5 8h7.5" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M2.5 12.5h4.5" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M12.5 8v4.5" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M10.25 10.25h4.5" }))),
  chevron: (size = 12) => svg(size, /* @__PURE__ */ import_react.default.createElement("path", { d: "M6 3.5 10.5 8 6 12.5" })),
  star: (size = 15, filled = false) => svg(size, /* @__PURE__ */ import_react.default.createElement("path", { d: "M8 1.9l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.3l-3.7 2.1.8-4.2L2 6.3l4.2-.5z", fill: filled ? "currentColor" : "none", strokeLinejoin: "round" })),
  pin: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M6 2.5h4l-.6 4 2.1 2.1v1H4.5v-1l2.1-2.1z", strokeLinejoin: "round" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M8 9.6V14" }))),
  copy: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("rect", { x: "5.5", y: "5.5", width: "8", height: "8" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M10.5 5.5v-3h-8v8h3" }))),
  close: (size = 12) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M3.5 3.5l9 9" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M12.5 3.5l-9 9" }))),
  refresh: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M13 8a5 5 0 1 1-1.5-3.6" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M13 2.5v3h-3" }))),
  open: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M9 2.5h4.5V7" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M13.5 2.5 7.5 8.5" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M11.5 9.5v4h-9v-9h4" }))),
  undo: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M5.5 3 2.5 6l3 3" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M2.5 6h7a4 4 0 0 1 0 8H7" }))),
  note: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M3 2.5h10v11H3z" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M5.5 6h5M5.5 9h5" }))),
  mail: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M2 3.5h12v9H2z" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M2 3.5 8 9l6-5.5" }))),
  plus: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M8 3v10" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M3 8h10" }))),
  check: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement("path", { d: "M3 8.5 6.5 12 13 4.5" })),
  inject: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M8 2.5v8" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M4.5 7 8 10.5 11.5 7" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M2.5 13.5h11" }))),
  edit: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M10.5 2.5l3 3-8 8h-3v-3z" }))),
  stop: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement("rect", { x: "4", y: "4", width: "8", height: "8" })),
  fork: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M4.5 2.5v4a3 3 0 0 0 3 3h1a3 3 0 0 1 3 3v1" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M11.5 2.5v4" }), /* @__PURE__ */ import_react.default.createElement("path", { d: "M4.5 9.5v4" }))),
  more: (size = 16) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("rect", { x: "2.5", y: "7.25", width: "1.5", height: "1.5", fill: "currentColor", stroke: "none" }), /* @__PURE__ */ import_react.default.createElement("rect", { x: "7.25", y: "7.25", width: "1.5", height: "1.5", fill: "currentColor", stroke: "none" }), /* @__PURE__ */ import_react.default.createElement("rect", { x: "12", y: "7.25", width: "1.5", height: "1.5", fill: "currentColor", stroke: "none" }))),
  send: (size = 14) => svg(size, /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement("path", { d: "M2.5 8 13.5 2.5 10 13.5 7.5 8.5z", strokeLinejoin: "round" })))
};
function Empty({ title, children, action }) {
  return /* @__PURE__ */ import_react.default.createElement("div", { className: "cdx-empty" }, /* @__PURE__ */ import_react.default.createElement("b", null, title), children, action ? /* @__PURE__ */ import_react.default.createElement("div", { className: "cdx-empty-act" }, action) : null);
}
function Note({ tone, children, actions, role }) {
  return /* @__PURE__ */ import_react.default.createElement("div", { className: "cdx-note" + (tone ? " " + tone : ""), role }, children, actions ? /* @__PURE__ */ import_react.default.createElement("div", { className: "cdx-btnrow" }, actions) : null);
}
function Skeleton({ rows = 3 }) {
  const list = [];
  for (let i = 0; i < rows; i += 1) list.push(/* @__PURE__ */ import_react.default.createElement("div", { key: i, className: "cdx-skel", "aria-hidden": "true" }));
  return /* @__PURE__ */ import_react.default.createElement("div", { "aria-busy": "true" }, list);
}
function SectionError({ what, error, onRetry }) {
  return /* @__PURE__ */ import_react.default.createElement(Note, { tone: "bad", role: "alert", actions: /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, onRetry ? /* @__PURE__ */ import_react.default.createElement("button", { type: "button", className: "cdx-btn s", onClick: onRetry }, "Retry") : null, /* @__PURE__ */ import_react.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => copyText(String(error && error.stack || error)) }, "Copy details")) }, "Couldn\u2019t load " + what + ". ", /* @__PURE__ */ import_react.default.createElement("span", { className: "cdx-help" }, String(error && error.message || error || "")));
}
function IconButton({ label, onClick, children, disabled, className, pressed, title }) {
  return /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      className: "cdx-ibtn" + (className ? " " + className : ""),
      "aria-label": label,
      title: title || label,
      "aria-disabled": disabled ? "true" : void 0,
      "aria-pressed": pressed === void 0 ? void 0 : pressed,
      onClick: (e) => {
        e.stopPropagation();
        if (!disabled && onClick) onClick(e);
      }
    },
    children
  );
}
function Switch({ checked, onChange, label, disabled }) {
  return /* @__PURE__ */ import_react.default.createElement(
    "button",
    {
      type: "button",
      role: "switch",
      className: "cdx-switch",
      "aria-checked": Boolean(checked),
      "aria-label": label,
      disabled,
      onClick: () => onChange(!checked)
    }
  );
}

// src/client/toasts.jsx
var import_react2 = __toESM(require("react"), 1);
var toastStore = createSignal([]);
var localLog = createSignal([]);
var announcer = createSignal({ text: "", at: 0 });
var seq = 0;
var timers = /* @__PURE__ */ new Map();
var MAX_VISIBLE = 3;
var LIVE_ID = "dsh-conductor-live";
function announce(text) {
  const value = String(text || "");
  announcer.set({ text: value, at: Date.now() });
  if (typeof document === "undefined" || !document.body) return;
  let region = document.getElementById(LIVE_ID);
  if (!region) {
    region = document.createElement("div");
    region.id = LIVE_ID;
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    region.style.cssText = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
    document.body.appendChild(region);
  }
  region.textContent = "";
  setTimeout(() => {
    region.textContent = value;
  }, 30);
}
function remove(id) {
  const t = timers.get(id);
  if (t && t.timer) clearTimeout(t.timer);
  timers.delete(id);
  toastStore.set(toastStore.get().filter((x) => x.id !== id));
}
function schedule(id, ms) {
  const entry = timers.get(id) || {};
  if (entry.timer) clearTimeout(entry.timer);
  entry.remaining = ms;
  entry.startedAt = Date.now();
  entry.timer = setTimeout(() => remove(id), ms);
  timers.set(id, entry);
}
function toast(spec) {
  seq += 1;
  const id = seq;
  const tone = spec.tone === "error" ? "error" : "info";
  const ms = tone === "error" ? 0 : spec.ms || (spec.undo ? Math.max(5, Math.min(30, pref("undoSeconds"))) * 1e3 : 4e3);
  const entry = { id, message: String(spec.message || ""), tone, undo: spec.undo || null, undoLabel: spec.undoLabel || "Undo", sessionId: spec.sessionId || null, ms, at: Date.now() };
  let list = [...toastStore.get(), entry];
  while (list.length > MAX_VISIBLE) {
    const oldest = list[0];
    const t = timers.get(oldest.id);
    if (t && t.timer) clearTimeout(t.timer);
    timers.delete(oldest.id);
    list = list.slice(1);
  }
  toastStore.set(list);
  if (ms > 0) schedule(id, ms);
  localLog.set([{ at: (/* @__PURE__ */ new Date()).toISOString(), kind: tone === "error" ? "error" : "ui", text: entry.message, sessionId: entry.sessionId }, ...localLog.get()].slice(0, 200));
  if (tone !== "error") announce(entry.message);
  return id;
}
function toastError(message, error, sessionId) {
  return toast({ tone: "error", message: message + (error ? " " + errorText(error) : ""), sessionId });
}
function dismissToast(id) {
  remove(id);
}
function pauseToasts(paused) {
  for (const [id, entry] of timers) {
    if (paused && entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
      entry.remaining = Math.max(800, entry.remaining - (Date.now() - entry.startedAt));
    } else if (!paused && !entry.timer) {
      schedule(id, entry.remaining);
    }
  }
}
async function runUndo(id) {
  const entry = toastStore.get().find((t) => t.id === id);
  if (!entry || !entry.undo) return;
  remove(id);
  try {
    const text = await entry.undo();
    toast({ message: text || "Undone.", sessionId: entry.sessionId });
  } catch (error) {
    toastError("Undo failed.", error, entry.sessionId);
  }
}
function latestUndo(sessionId) {
  const list = toastStore.get().filter((t) => t.undo && (!sessionId || !t.sessionId || t.sessionId === sessionId));
  return list.length ? list[list.length - 1] : null;
}
function ToastView({ t, paused }) {
  return /* @__PURE__ */ import_react2.default.createElement(
    "div",
    {
      className: "cdx-toast" + (t.tone === "error" ? " bad" : "") + (paused ? " paused" : ""),
      role: t.tone === "error" ? "alert" : "status",
      "data-toast": t.id
    },
    /* @__PURE__ */ import_react2.default.createElement("span", { className: "cdx-grow" }, t.message),
    t.undo ? /* @__PURE__ */ import_react2.default.createElement("button", { type: "button", className: "cdx-btn s", "data-toast-undo": true, onClick: () => runUndo(t.id) }, t.undoLabel) : null,
    /* @__PURE__ */ import_react2.default.createElement("button", { type: "button", className: "cdx-ibtn", "aria-label": "Dismiss notification", title: "Dismiss", onClick: () => dismissToast(t.id) }, Icon.close(12)),
    t.ms > 0 ? /* @__PURE__ */ import_react2.default.createElement("span", { className: "cdx-toast-bar", "aria-hidden": "true", style: { animationDuration: t.ms + "ms" } }) : null
  );
}
function ToastHost({ sessionId }) {
  const all = useSignal(toastStore);
  const [paused, setPaused] = (0, import_react2.useState)(false);
  const ref = (0, import_react2.useRef)(null);
  const list = all.filter((t) => !t.sessionId || t.sessionId === sessionId);
  (0, import_react2.useEffect)(() => {
    pauseToasts(paused);
  }, [paused]);
  (0, import_react2.useEffect)(() => () => pauseToasts(false), []);
  if (!list.length) return null;
  return /* @__PURE__ */ import_react2.default.createElement(
    "div",
    {
      className: "cdx-toasts",
      ref,
      onMouseEnter: () => setPaused(true),
      onMouseLeave: () => setPaused(false),
      onFocus: () => setPaused(true),
      onBlur: (e) => {
        if (!ref.current || !ref.current.contains(e.relatedTarget)) setPaused(false);
      }
    },
    list.map((t) => /* @__PURE__ */ import_react2.default.createElement(ToastView, { key: t.id, t, paused }))
  );
}
function LiveRegions() {
  return /* @__PURE__ */ import_react2.default.createElement("div", { className: "cdx-sr", "aria-live": "assertive", "aria-atomic": "true", "data-live": "assertive" });
}

// src/client/setup.jsx
var SETUP_STEPS = [
  { id: "welcome", title: "Welcome" },
  { id: "model", title: "What the assistant may do on its own" },
  { id: "automation", title: "When the context fills up" },
  { id: "ghosts", title: "Ghosts and scripts" },
  { id: "agents", title: "Agents and tasks" },
  { id: "ready", title: "Ready" }
];
var MAY_COPY = {
  drop: "Drop old tool output and messages from its own context.",
  edit: "Rewrite its own earlier answers (every version is kept).",
  pin: "Pin messages so they survive a reset.",
  new: "Start a fresh context with a handoff, after its turn ends.",
  compact: "Summarise its context into a checkpoint.",
  clear: "Empty its context. Off by default: nothing is carried over.",
  post: "Leave silent messages in other chats.",
  prompt: "Send messages that wake other chats.",
  spawn: "Start new agents.",
  cancel: "Stop other chats."
};
var TOOL_COPY = [
  ["chat", "chat", "Manage its own context (needed for everything above)."],
  ["chats", "chats", "List, prompt and post to other chats."],
  ["tasks", "tasks", "Run and read background tasks."]
];
var STEP_KEYS = { model: ["modelMay", "tools"], automation: ["autoCompact"], ghosts: ["modules"], agents: ["modules", "tasks"] };
function stepPatch(stepId, form) {
  const full = buildSettingsPatch(form);
  const patch = {};
  for (const k of STEP_KEYS[stepId] || []) patch[k] = full[k];
  return patch;
}
function generateSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
var USAGE_LINE = 'dsh-post --kind report "<chat title>" "Build finished"   # reads DSH_CONDUCTOR_SECRET';
var setupOpen = createSignal(false);
function Dots({ step }) {
  return /* @__PURE__ */ import_react3.default.createElement("ol", { className: "cdx-dots", "aria-label": "Step " + (step + 1) + " of " + SETUP_STEPS.length }, SETUP_STEPS.map((s, i) => /* @__PURE__ */ import_react3.default.createElement("li", { key: s.id, className: i === step ? "on" : i < step ? "done" : "", "aria-current": i === step ? "step" : void 0 }, /* @__PURE__ */ import_react3.default.createElement("span", { className: "cdx-sr" }, (i < step ? "Done: " : i === step ? "Current: " : "") + s.title))));
}
function AutomationStep({ form, set }) {
  const ac = form.autoCompact || { percent: 0, action: "compact", nudge: true };
  const choice = !ac.percent ? "default" : ac.percent === 50 && ac.action === "handoff" ? "handoff50" : "custom";
  return /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-wbody" }, /* @__PURE__ */ import_react3.default.createElement("p", { className: "cdx-help" }, "What happens on its own when a chat's context gets full. A chat can change this later in Conductor, Automation."), /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-radio", role: "radiogroup", "aria-label": "When the context fills up" }, /* @__PURE__ */ import_react3.default.createElement("label", null, /* @__PURE__ */ import_react3.default.createElement("input", { type: "radio", name: "cdx-setup-level", checked: choice === "default", onChange: () => set(["autoCompact"], { ...ac, percent: 0, action: "compact" }) }), /* @__PURE__ */ import_react3.default.createElement("span", null, "Default", /* @__PURE__ */ import_react3.default.createElement("span", { className: "cdx-help", style: { display: "block" } }, "DSH compacts at about 80%."))), /* @__PURE__ */ import_react3.default.createElement("label", null, /* @__PURE__ */ import_react3.default.createElement("input", { type: "radio", name: "cdx-setup-level", "data-setup-handoff50": true, checked: choice === "handoff50", onChange: () => set(["autoCompact"], { ...ac, percent: 50, action: "handoff" }) }), /* @__PURE__ */ import_react3.default.createElement("span", null, "Hand off at 50%", /* @__PURE__ */ import_react3.default.createElement("span", { className: "cdx-help", style: { display: "block" } }, "A fresh context from a handoff, long before the model gets slow."))), /* @__PURE__ */ import_react3.default.createElement("label", null, /* @__PURE__ */ import_react3.default.createElement("input", { type: "radio", name: "cdx-setup-level", checked: choice === "custom", onChange: () => set(["autoCompact"], { ...ac, percent: ac.percent && choice !== "handoff50" ? ac.percent : 65, action: ac.action || "compact" }) }), "Custom")), choice === "custom" ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-acustom" }, /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react3.default.createElement(
    "input",
    {
      type: "range",
      min: 10,
      max: 95,
      step: 5,
      value: ac.percent,
      "aria-label": "Level, percent of the model window",
      style: { flex: 1, accentColor: "var(--clay)" },
      onChange: (e) => set(["autoCompact", "percent"], Number(e.target.value))
    }
  ), /* @__PURE__ */ import_react3.default.createElement("span", { className: "cdx-num", style: { width: 36, textAlign: "right" } }, ac.percent + "%")), /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-radio", role: "radiogroup", "aria-label": "What happens at the level", style: { flexDirection: "row", gap: 16 } }, /* @__PURE__ */ import_react3.default.createElement("label", null, /* @__PURE__ */ import_react3.default.createElement("input", { type: "radio", name: "cdx-setup-act", checked: ac.action !== "handoff", onChange: () => set(["autoCompact", "action"], "compact") }), "Compact"), /* @__PURE__ */ import_react3.default.createElement("label", null, /* @__PURE__ */ import_react3.default.createElement("input", { type: "radio", name: "cdx-setup-act", checked: ac.action === "handoff", onChange: () => set(["autoCompact", "action"], "handoff") }), "Hand off"))) : null);
}
function ToggleRow({ title, desc, checked, onChange, warn: warn2 }) {
  return /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-wrow" }, /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-grow" }, /* @__PURE__ */ import_react3.default.createElement("div", { className: "t" }, title), desc ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "d" }, desc) : null, warn2 && checked ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "d warn", role: "note" }, warn2) : null), /* @__PURE__ */ import_react3.default.createElement(Switch, { checked: Boolean(checked), label: title, onChange }));
}
function SetupGuide({ settings, onDone }) {
  const initial = settings && settings.settings || {};
  const [form, setForm] = (0, import_react3.useState)(() => JSON.parse(JSON.stringify(initial)));
  const [step, setStep] = (0, import_react3.useState)(0);
  const [busy, setBusy] = (0, import_react3.useState)(false);
  const [error, setError] = (0, import_react3.useState)(null);
  const [secretState, setSecretState] = (0, import_react3.useState)(null);
  const secretRef = (0, import_react3.useRef)("");
  const headRef = (0, import_react3.useRef)(null);
  const cur = SETUP_STEPS[step];
  const set = (path, value) => setForm((f) => setPath(f, path, value));
  const get = (path) => getPath(form, path);
  (0, import_react3.useEffect)(() => {
    setupOpen.set(true);
    return () => setupOpen.set(false);
  }, []);
  (0, import_react3.useEffect)(() => {
    if (headRef.current) headRef.current.focus({ preventScroll: true });
    announce("Setup, step " + (step + 1) + " of " + SETUP_STEPS.length + ": " + SETUP_STEPS[step].title);
  }, [step]);
  (0, import_react3.useEffect)(() => () => {
    secretRef.current = "";
  }, []);
  const run = async (fn, retry) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError({ text: errorText(e), retry });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    const ok = await run(async () => {
      await mutate("PUT", "/settings", { setupCompleted: (/* @__PURE__ */ new Date()).toISOString() });
      await refreshSettings();
    }, finish);
    if (ok) {
      setupRerun.set(false);
      announce("Setup finished.");
      if (onDone) onDone();
    }
  };
  const next = async () => {
    const patch = stepPatch(cur.id, form);
    if (Object.keys(patch).length) {
      const ok = await run(async () => {
        await mutate("PUT", "/settings", patch);
        refreshSettings();
      }, next);
      if (!ok) return;
    }
    setStep((s) => Math.min(SETUP_STEPS.length - 1, s + 1));
  };
  const skip = () => {
    setError(null);
    setStep((s) => Math.min(SETUP_STEPS.length - 1, s + 1));
  };
  const back = () => {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  };
  const makeSecret = async () => {
    const value = generateSecret();
    await run(async () => {
      const r = await post("/secret", { secret: value });
      secretRef.current = value;
      setSecretState({ fingerprint: r.fingerprint || "" });
      refreshSettings();
    }, makeSecret);
  };
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      if (headRef.current) headRef.current.focus();
    }
  };
  const api = form.api || {};
  const alreadySecret = Boolean(api.secretConfigured || settings && settings.envSecretPresent);
  return /* @__PURE__ */ import_react3.default.createElement("section", { className: "cdx-wizard", "aria-labelledby": "cdx-setup-title", onKeyDown, "data-setup-step": cur.id }, /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-wtop" }, /* @__PURE__ */ import_react3.default.createElement("span", { className: "cdx-help" }, "Setup \xB7 step " + (step + 1) + " of " + SETUP_STEPS.length), /* @__PURE__ */ import_react3.default.createElement(Dots, { step })), /* @__PURE__ */ import_react3.default.createElement("h2", { id: "cdx-setup-title", ref: headRef, tabIndex: -1, className: "cdx-wtitle" }, cur.title), cur.id === "welcome" ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-wbody" }, /* @__PURE__ */ import_react3.default.createElement("p", null, "Conductor keeps this chat's context under control."), /* @__PURE__ */ import_react3.default.createElement("ul", { className: "cdx-wlist" }, /* @__PURE__ */ import_react3.default.createElement("li", null, /* @__PURE__ */ import_react3.default.createElement("b", null, "New context"), " starts fresh from a handoff the assistant writes, without losing the thread (/new)."), /* @__PURE__ */ import_react3.default.createElement("li", null, /* @__PURE__ */ import_react3.default.createElement("b", null, "Drop"), " big items the model no longer needs, and ", /* @__PURE__ */ import_react3.default.createElement("b", null, "pin"), " the ones it must keep."), /* @__PURE__ */ import_react3.default.createElement("li", null, /* @__PURE__ */ import_react3.default.createElement("b", null, "Ghosts"), " are silent messages between chats and scripts: they inform without waking anyone."))) : null, cur.id === "model" ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-wbody" }, /* @__PURE__ */ import_react3.default.createElement("p", { className: "cdx-help" }, "You can always do all of this yourself. These switches decide what the assistant may do on its own."), /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-wgroup", role: "group", "aria-label": "The assistant may" }, MODEL_MAY.map(([k, title]) => /* @__PURE__ */ import_react3.default.createElement(ToggleRow, { key: k, title: title.replace(/ \(.*\)$/, ""), desc: MAY_COPY[k], checked: get(["modelMay", k]), onChange: (v) => set(["modelMay", k], v) }))), /* @__PURE__ */ import_react3.default.createElement("h3", { className: "cdx-wsub" }, "Model tools"), /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-wgroup", role: "group", "aria-label": "Model tools" }, TOOL_COPY.map(([k, title, desc]) => /* @__PURE__ */ import_react3.default.createElement(ToggleRow, { key: k, title: title + " tool", desc, checked: get(["tools", k]), onChange: (v) => set(["tools", k], v) })), /* @__PURE__ */ import_react3.default.createElement(ToggleRow, { title: "Keep old orch_* tool names", desc: "Only if prompts or agents still call the dsh-orchestrator tools.", checked: get(["tools", "legacy"]), onChange: (v) => set(["tools", "legacy"], v) }))) : null, cur.id === "automation" ? /* @__PURE__ */ import_react3.default.createElement(AutomationStep, { form, set }) : null, cur.id === "ghosts" ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-wbody" }, /* @__PURE__ */ import_react3.default.createElement(
    ToggleRow,
    {
      title: "Inbox and ghosts",
      desc: "Other chats and scripts can leave silent messages here. They show in the chat and wake nobody.",
      checked: get(["modules", "posts"]),
      onChange: (v) => set(["modules", "posts"], v)
    }
  ), /* @__PURE__ */ import_react3.default.createElement("h3", { className: "cdx-wsub" }, "Scripts (machine API)"), /* @__PURE__ */ import_react3.default.createElement("p", { className: "cdx-help" }, "A secret lets scripts and cron jobs post ghosts with dsh-post. Without one the machine API stays closed."), secretState ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-wsecret", "data-secret-ready": true }, /* @__PURE__ */ import_react3.default.createElement("div", null, "Secret saved" + (secretState.fingerprint ? " (fingerprint " + secretState.fingerprint + ")" : "") + ". It is shown nowhere; copy it now and store it as DSH_CONDUCTOR_SECRET where your scripts run."), /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react3.default.createElement("button", { type: "button", className: "cdx-btn s", "data-copy-secret": true, onClick: async () => {
    const ok = await copyText(secretRef.current);
    announce(ok ? "Secret copied." : "Copy is not available in this browser.");
  } }, "Copy secret"), /* @__PURE__ */ import_react3.default.createElement("button", { type: "button", className: "cdx-btn s g", "data-copy-usage": true, onClick: async () => {
    const ok = await copyText(USAGE_LINE);
    announce(ok ? "Usage line copied." : "Copy is not available in this browser.");
  } }, "Copy usage line")), /* @__PURE__ */ import_react3.default.createElement("pre", { className: "cdx-pre log" }, USAGE_LINE)) : /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react3.default.createElement("button", { type: "button", className: "cdx-btn s", "data-generate-secret": true, disabled: busy, onClick: makeSecret }, alreadySecret ? "Replace the secret" : "Generate a secret"), alreadySecret ? /* @__PURE__ */ import_react3.default.createElement("span", { className: "cdx-help" }, "A secret is already set" + (api.secretFingerprint ? " (" + api.secretFingerprint + ")" : "") + ".") : /* @__PURE__ */ import_react3.default.createElement("span", { className: "cdx-help" }, "Or skip: you can add one later in Settings."))) : null, cur.id === "agents" ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-wbody" }, /* @__PURE__ */ import_react3.default.createElement(
    ToggleRow,
    {
      title: "Agents and tasks",
      desc: "Spawn and message other chats, run background tasks, see what is running.",
      checked: get(["modules", "orchestration"]),
      onChange: (v) => set(["modules", "orchestration"], v)
    }
  ), /* @__PURE__ */ import_react3.default.createElement(
    ToggleRow,
    {
      title: "Shell command tasks",
      desc: "Off by default.",
      warn: "Anything that can create a task can then run shell commands on this host.",
      checked: get(["tasks", "allowCommandTasks"]),
      onChange: (v) => set(["tasks", "allowCommandTasks"], v)
    }
  ), /* @__PURE__ */ import_react3.default.createElement(
    ToggleRow,
    {
      title: "Remote runners",
      desc: "Off by default.",
      warn: "Tasks may then run over ssh or http on other machines.",
      checked: get(["tasks", "allowRemoteRunners"]),
      onChange: (v) => set(["tasks", "allowRemoteRunners"], v)
    }
  )) : null, cur.id === "ready" ? /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-wbody" }, /* @__PURE__ */ import_react3.default.createElement("ul", { className: "cdx-wlist" }, /* @__PURE__ */ import_react3.default.createElement("li", null, "When the meter runs high, type ", /* @__PURE__ */ import_react3.default.createElement("b", null, "/new"), " or press ", /* @__PURE__ */ import_react3.default.createElement("b", null, "New context"), "."), /* @__PURE__ */ import_react3.default.createElement("li", null, "In ", /* @__PURE__ */ import_react3.default.createElement("b", null, "Context"), ", drop the biggest items first."), /* @__PURE__ */ import_react3.default.createElement("li", null, "Star a message to ", /* @__PURE__ */ import_react3.default.createElement("b", null, "pin"), " it across every reset.")), /* @__PURE__ */ import_react3.default.createElement("p", { className: "cdx-help" }, "Everything here can be changed later in Settings, Conductor.")) : null, error ? /* @__PURE__ */ import_react3.default.createElement(Note, { tone: "bad", role: "alert", actions: /* @__PURE__ */ import_react3.default.createElement(import_react3.default.Fragment, null, error.retry ? /* @__PURE__ */ import_react3.default.createElement("button", { type: "button", className: "cdx-btn s", onClick: () => error.retry() }, "Retry") : null, cur.id !== "welcome" && cur.id !== "ready" ? /* @__PURE__ */ import_react3.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: skip }, "Continue without saving") : null) }, "Couldn\u2019t save: " + error.text + ". Nothing on this step was changed.") : null, /* @__PURE__ */ import_react3.default.createElement("div", { className: "cdx-wnav" }, cur.id === "welcome" ? /* @__PURE__ */ import_react3.default.createElement(import_react3.default.Fragment, null, /* @__PURE__ */ import_react3.default.createElement("button", { type: "button", className: "cdx-btn p", "data-setup-start": true, disabled: busy, onClick: () => setStep(1) }, "Set up (1 minute)"), /* @__PURE__ */ import_react3.default.createElement("button", { type: "button", className: "cdx-btn g", "data-setup-defaults": true, disabled: busy, onClick: finish }, "Use defaults")) : cur.id === "ready" ? /* @__PURE__ */ import_react3.default.createElement(import_react3.default.Fragment, null, /* @__PURE__ */ import_react3.default.createElement("button", { type: "button", className: "cdx-btn g", disabled: busy, onClick: back }, "Back"), /* @__PURE__ */ import_react3.default.createElement("span", { className: "cdx-spacer" }), /* @__PURE__ */ import_react3.default.createElement("button", { type: "button", className: "cdx-btn p", "data-setup-finish": true, disabled: busy, onClick: finish }, busy ? "Saving\u2026" : "Open Conductor")) : /* @__PURE__ */ import_react3.default.createElement(import_react3.default.Fragment, null, /* @__PURE__ */ import_react3.default.createElement("button", { type: "button", className: "cdx-btn g", disabled: busy, onClick: back }, "Back"), /* @__PURE__ */ import_react3.default.createElement("span", { className: "cdx-spacer" }), /* @__PURE__ */ import_react3.default.createElement("button", { type: "button", className: "cdx-btn g", "data-setup-skip": true, disabled: busy, onClick: skip }, "Skip"), /* @__PURE__ */ import_react3.default.createElement("button", { type: "button", className: "cdx-btn p", "data-setup-next": true, disabled: busy, onClick: next }, busy ? "Saving\u2026" : "Next"))));
}

// src/client/styles.js
var STYLE_ID = PLUGIN_ID + "-styles";
var VARS = [
  "--ok:var(--dsw-alias-state-success-primary,#4f9d69)",
  "--warn:var(--dsw-alias-state-warn-primary,#c8952f)",
  "--bad:var(--dsw-alias-state-error-primary,#e0685a)",
  "--clay:var(--tz-accent,var(--dsw-alias-brand-primary,#c1553a))",
  "--on-clay:var(--tz-on-accent,var(--dsw-alias-label-primary-foreground,#fbf7f4))",
  "--blue:var(--tz-accent-2,#5e9bd6)",
  "--link:var(--dsw-alias-link,var(--tz-accent-2,#5e9bd6))",
  "--ink:var(--dsw-alias-label-primary,inherit)",
  "--ink2:var(--dsw-alias-label-secondary,inherit)",
  "--ink3:var(--dsw-alias-label-tertiary,inherit)",
  "--line:var(--dsw-alias-border-l2,rgba(128,128,128,.28))",
  "--line1:var(--dsw-alias-border-l1,rgba(128,128,128,.16))",
  "--base:var(--dsw-alias-bg-base,transparent)",
  "--l1:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#1b1817))",
  "--l2:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07))",
  "--l3:var(--dsw-alias-bg-layer-3,#2a2523)",
  "--hov:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))",
  "--sel:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.18))",
  "--mono:var(--tz-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)",
  "--ease:var(--tz-ease,cubic-bezier(.2,.7,.3,1))",
  "--pop:var(--tz-shadow-pop,6px 6px 0 rgba(0,0,0,.35))",
  "--c-system:repeating-linear-gradient(135deg,var(--dsw-static-neutral-bluish-600,#7d7470) 0 3px,color-mix(in srgb,var(--dsw-static-neutral-bluish-600,#7d7470) 40%,transparent) 3px 5px)",
  "--c-instr:var(--tz-accent-2,#5e9bd6)",
  "--c-handoff:var(--dsw-alias-state-success-secondary,#62ad7b)",
  "--c-msg:var(--dsw-alias-label-secondary,#c0b7b2)",
  "--c-tool:var(--tz-accent,#c1553a)"
].join(";");
var CSS = `
.cdx{${VARS};position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;
  font:inherit;font-size:13px;line-height:1.4;color:var(--ink);container-type:inline-size;container-name:cdx}
.cdx *,.cdx-set *,.cdx-star *{box-sizing:border-box;border-radius:0}
.cdx :focus-visible,.cdx-set :focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.cdx-num{font-family:var(--mono);font-size:11.5px;font-variant-numeric:tabular-nums}
.cdx-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.cdx-grow{flex:1;min-width:0}
.cdx-ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}

/* header: one line of numbers, a thin bar, the actions */
.cdx-head{flex:none;position:relative;padding:12px 14px 12px}
.cdx-meter{display:flex;flex-direction:column;gap:6px}
.cdx-mline{all:unset;box-sizing:border-box;display:flex;align-items:baseline;gap:8px;cursor:pointer;color:var(--ink2);align-self:flex-start;padding:1px 2px;margin:-1px -2px}
.cdx-mline:hover{color:var(--ink)}
.cdx-mline:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.cdx-mline .cdx-num{font-size:12px}
.cdx-mline b{color:var(--ink);font-weight:600;font-size:13px}
.cdx-pct{color:var(--ink3);font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums}
.cdx-pct.warn{color:var(--warn)}.cdx-pct.bad{color:var(--bad);font-weight:600}
.cdx-chev{flex:none;color:var(--ink3);display:inline-flex;transition:transform 120ms var(--ease)}
.cdx-thin{position:relative;height:3px;background:var(--l2)}
.cdx-thin>i{display:block;height:100%;background:var(--ink3);transition:width 180ms var(--ease)}
.cdx-thin.warn>i{background:var(--warn)}.cdx-thin.bad>i{background:var(--bad)}
.cdx-tick{position:absolute;top:-2px;bottom:-2px;width:2px;margin-left:-1px;background:var(--warn)}
.cdx-ltick{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:var(--clay)}
.cdx-asum{all:unset;box-sizing:border-box;align-self:flex-start;max-width:100%;font-size:11.5px;line-height:16px;color:var(--ink3);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cdx-asum:hover{color:var(--ink)}
.cdx-asum:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.cdx-breakdown{list-style:none;margin:2px 0 0;padding:0}
.cdx-brow{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:24px;padding:0 4px;font-size:12px;color:var(--ink2);cursor:pointer}
.cdx-brow:hover{background:var(--hov);color:var(--ink)}
.cdx-brow:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}
.cdx-brow.muted{cursor:default}.cdx-brow.muted:hover{background:transparent;color:var(--ink2)}
.cdx-brow.muted .cdx-sw{box-shadow:inset 0 0 0 1px var(--line)}
.cdx-chipbtn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;min-height:24px;padding:0 6px;font-size:11.5px;color:var(--ink2);cursor:pointer;white-space:nowrap}
.cdx-chipbtn:hover{background:var(--hov);color:var(--ink)}
.cdx-chipbtn[aria-pressed=true]{color:var(--ink);box-shadow:inset 0 -2px 0 var(--clay)}
.cdx-chipbtn:focus-visible{outline:2px solid var(--blue);outline-offset:0}
.cdx-sw{display:inline-block;width:8px;height:8px;flex:none}
.cdx-hint{padding:6px 8px;font-size:12px;line-height:1.45;border-left:2px solid var(--bad);background:var(--l2);color:var(--ink)}
.cdx-actions{display:flex;align-items:center;gap:6px;margin-top:12px}
.cdx-menuwrap{position:relative;display:inline-flex}
.cdx-menuwrap>.cdx-ibtn{width:28px;height:28px}
.cdx-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:30;min-width:200px;display:flex;flex-direction:column;padding:4px 0;background:var(--l3);border:1px solid var(--line);box-shadow:var(--pop)}
.cdx-mitem{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:12px;min-height:30px;padding:0 12px;font-size:12.5px;color:var(--ink);cursor:pointer}
.cdx-mitem:hover,.cdx-mitem:focus{background:var(--hov);outline:none}
.cdx-mitem:focus-visible{box-shadow:inset 2px 0 0 var(--blue)}
.cdx-mitem[aria-disabled=true]{opacity:.45;cursor:not-allowed}
.cdx-mhint{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--ink3)}
.cdx-confirm{margin-top:12px;padding:10px 12px;border-left:2px solid var(--warn);background:var(--l2);font-size:12px;line-height:1.5}
.cdx-confirm .cdx-actions{margin-top:8px}
.cdx-progress{margin-top:12px;padding:10px 12px 12px;border-left:2px solid var(--clay);background:var(--l2);position:relative;overflow:hidden}
.cdx-ptitle{display:flex;align-items:baseline;gap:8px;font-weight:600}
.cdx-ptitle .cdx-num{margin-left:auto;font-weight:500;color:var(--ink2)}
.cdx-psub{font-size:12px;color:var(--ink2);margin-top:2px}
.cdx-indet{position:absolute;left:0;right:0;bottom:0;height:2px;overflow:hidden}
.cdx-indet::before{content:"";position:absolute;top:0;bottom:0;width:30%;background:var(--clay);animation:cdx-indet 1.3s var(--ease) infinite}
@keyframes cdx-indet{0%{left:-30%}100%{left:100%}}
.cdx-result{display:flex;align-items:flex-start;gap:8px;margin-top:12px;padding:8px 6px 8px 12px;font-size:12px;line-height:1.5;border-left:2px solid var(--ok);background:var(--l2)}
.cdx-result.bad{border-left-color:var(--bad)}.cdx-result.warn{border-left-color:var(--warn)}
.cdx-result .cdx-links{display:flex;gap:14px;margin-top:3px;flex-wrap:wrap}

/* buttons and links */
.cdx-btn{font:inherit;font-size:12px;line-height:16px;min-height:26px;padding:4px 10px;border:1px solid var(--line);background:transparent;color:var(--ink);
  cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;transition:background-color 120ms var(--ease)}
.cdx-btn:hover:not(:disabled){background:var(--hov)}
.cdx-btn:disabled{opacity:.45;cursor:not-allowed}
.cdx-btn.p{background:var(--clay);border-color:var(--clay);color:var(--on-clay);font-weight:600}
.cdx-btn.p:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--clay));filter:brightness(1.06)}
.cdx-btn.d{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 70%,transparent)}
.cdx-btn.g{border-color:transparent;color:var(--ink2)}
.cdx-btn.g:hover:not(:disabled){color:var(--ink)}
.cdx-btn.s{min-height:24px;padding:2px 8px;font-size:11.5px}
.cdx-ibtn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;color:var(--ink3);cursor:pointer}
.cdx-ibtn:hover:not([aria-disabled=true]){background:var(--hov);color:var(--ink)}
.cdx-ibtn:focus-visible{outline:2px solid var(--blue);outline-offset:-1px}
.cdx-ibtn[aria-disabled=true]{opacity:.4;cursor:not-allowed}
.cdx-ibtn.on{color:var(--clay)}
.cdx-link{all:unset;box-sizing:border-box;color:var(--link);cursor:pointer;font-size:12px;line-height:18px}
.cdx-link:hover{text-decoration:underline}
.cdx-link:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.cdx-spacer{flex:1}

/* sub-tabs: one segmented bar, one panel */
.cdx-tabs{flex:none;display:flex;gap:2px;padding:0 10px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.cdx-tabs [role=tab]{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 8px;font-size:12.5px;color:var(--ink3);cursor:pointer;white-space:nowrap;
  box-shadow:inset 0 -2px 0 transparent;transition:color 120ms var(--ease),box-shadow 120ms var(--ease)}
.cdx-tabs [role=tab]:hover{color:var(--ink)}
.cdx-tabs [role=tab][aria-selected=true]{color:var(--ink);font-weight:600;box-shadow:inset 0 -2px 0 var(--ink)}
.cdx-tabs [role=tab]:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}
.cdx-tcount{font-family:var(--mono);font-size:10.5px;font-weight:500;color:var(--ink3);font-variant-numeric:tabular-nums}
.cdx-tcount.live{color:var(--clay);font-weight:600}
@container cdx (max-width:359px){.cdx-tabs{padding:0 4px}.cdx-tabs [role=tab]{padding:0 6px;font-size:12px}}

/* automation, checkpoints, recall */
.cdx-apart{display:flex;flex-direction:column;gap:8px;padding:6px 14px 12px;border-bottom:1px solid var(--line1)}
.cdx-apart:last-child{border-bottom:0}
.cdx-acustom{display:flex;flex-direction:column;gap:6px;padding-left:20px}
.cdx-cp.auto .cdx-title{color:var(--ink2)}
.cdx-cp.auto .cdx-title>span{font-weight:400}
.cdx-cp .cdx-title>span{font-weight:500}
.cdx-rewind{display:flex;flex-direction:column;gap:8px;margin:6px 0 2px;padding:10px 12px;border-left:2px solid var(--warn);background:var(--l2);font-size:12px}
.cdx-plan{display:flex;flex-direction:column;gap:4px}
.cdx-flist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;font-family:var(--mono);font-size:11px}
.cdx-flist li{display:flex;gap:8px;justify-content:space-between;min-width:0}
.cdx-flist li.conflict{color:var(--warn)}
.cdx-lell{direction:rtl;text-align:left}
.cdx-flist .cdx-help{font-family:inherit;flex:none}
.cdx-check2{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink);cursor:pointer}
.cdx-check2.warn{color:var(--warn)}
.cdx-snippet{font-family:var(--mono);font-size:11px;line-height:1.5;color:var(--ink2);white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}

/* first-run setup guide */
.cdx-wizard{display:flex;flex-direction:column;gap:12px;padding:16px 14px 12px}
.cdx-wtop{display:flex;align-items:center;gap:10px}
.cdx-dots{display:flex;gap:6px;list-style:none;margin:0 0 0 auto;padding:0}
.cdx-dots li{width:8px;height:8px;background:var(--l2);box-shadow:inset 0 0 0 1px var(--line)}
.cdx-dots li.done{background:var(--ink3);box-shadow:none}
.cdx-dots li.on{background:var(--clay);box-shadow:none}
.cdx-wtitle{margin:0;font-size:15px;line-height:1.35;font-weight:600;color:var(--ink)}
.cdx-wtitle:focus{outline:none}
.cdx-wtitle:focus-visible{outline:none}
.cdx-wbody{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.55;color:var(--ink)}
.cdx-wbody p{margin:0}
.cdx-wlist{margin:0;padding:0 0 0 18px;display:flex;flex-direction:column;gap:6px;color:var(--ink2)}
.cdx-wlist b{color:var(--ink);font-weight:600}
.cdx-wsub{margin:6px 0 0;font-size:11px;font-weight:600;color:var(--ink3)}
.cdx-wgroup{display:flex;flex-direction:column}
.cdx-wrow{display:flex;align-items:flex-start;gap:12px;padding:8px 0;border-bottom:1px solid var(--line1)}
.cdx-wrow:last-child{border-bottom:0}
.cdx-wrow .t{font-size:13px;color:var(--ink)}
.cdx-wrow .d{font-size:11.5px;color:var(--ink3);line-height:1.45}
.cdx-wrow .d.warn{color:var(--warn)}
.cdx-wrow .cdx-switch{margin-top:2px}
.cdx-wsecret{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-left:2px solid var(--ok);background:var(--l2);font-size:12px}
.cdx-wsecret .cdx-pre.log{white-space:pre-wrap;word-break:break-word;margin:0}
.cdx-wnav{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:8px}
.cdx-wizard .cdx-note{margin:0}

/* panels */
.cdx-fallback{margin:12px 14px 0;padding:6px 10px;font-size:12px;line-height:1.5;color:var(--ink2);border-left:2px solid var(--warn);background:var(--l2)}
.cdx-meta.warn{color:var(--warn)}
.cdx-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l1,var(--line)) transparent}
.cdx-body:focus{outline:none}
.cdx-phead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 14px 4px;min-height:32px}
.cdx-panelfoot{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:10px 14px 12px}
.cdx-sub{display:flex;align-items:center;gap:8px;padding:14px 14px 4px;font-size:11px;font-weight:600;color:var(--ink3)}
.cdx-sub .cdx-btn,.cdx-sub .cdx-chipbtn{font-weight:500}

/* rows */
.cdx-list{list-style:none;margin:0;padding:0}
.cdx-row{position:relative;display:grid;grid-template-columns:18px minmax(0,1fr) auto;gap:2px 8px;align-items:center;min-height:36px;padding:6px 12px 6px 14px;border-bottom:1px solid var(--line1)}
.cdx-list>li:last-child>.cdx-row,.cdx-list>.cdx-row:last-child{border-bottom:0}
.cdx-list.plain .cdx-row{border-bottom:0;padding-top:7px;padding-bottom:7px}
.cdx-pinmark{display:inline-flex;color:var(--clay);flex:none}
.cdx-sizenum{min-width:38px;text-align:right;color:var(--ink2)}
.cdx-under{position:absolute;left:14px;right:12px;bottom:2px;width:auto;height:2px;box-shadow:none;background:transparent;opacity:.55}
.cdx-drop1{min-width:46px}
.cdx-when{font-size:11px;color:var(--ink3);line-height:18px}
.cdx-line{font-size:12.5px;line-height:18px;color:var(--ink2);overflow-wrap:anywhere}
.cdx-line.bad{color:var(--bad)}
.cdx-row:hover{background:var(--hov)}
.cdx-row.click{cursor:pointer}
.cdx-row:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}
.cdx-row[aria-selected=true],.cdx-row.ticked{background:var(--sel);box-shadow:inset 2px 0 0 var(--clay)}
.cdx-row.unread{box-shadow:inset 2px 0 0 var(--clay)}
.cdx-row.unread .cdx-title{font-weight:600;color:var(--ink)}
.cdx-row.muted .cdx-title{color:var(--ink2)}
.cdx-row.gone{opacity:.62}
.cdx-main{min-width:0;display:flex;flex-direction:column;gap:1px}
.cdx-title{display:flex;align-items:center;gap:6px;min-width:0;color:var(--ink);font-size:13px;line-height:18px}
.cdx-title>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.cdx-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal}
.cdx-meta{display:flex;align-items:center;gap:6px;min-width:0;font-size:11px;line-height:16px;color:var(--ink3);white-space:nowrap;overflow:hidden}
.cdx-meta>span{overflow:hidden;text-overflow:ellipsis}
.cdx-dot{display:inline-block;width:7px;height:7px;flex:none}
.cdx-dot.live{background:var(--clay)}
.cdx-dot.idle{background:var(--ink3)}
.cdx-dot.ok{background:var(--ok)}.cdx-dot.bad{background:var(--bad)}.cdx-dot.warn{background:var(--warn)}
.cdx-dot.pulse{animation:cdx-pulse 1.4s ease-in-out infinite}
@keyframes cdx-pulse{50%{opacity:.35}}
.cdx-chip{display:inline-flex;align-items:center;gap:3px;flex:none;font-size:10.5px;line-height:15px;padding:0 5px;border:1px solid var(--line);color:var(--ink2);white-space:nowrap;font-weight:500}
.cdx-chip.clay{color:var(--clay);border-color:color-mix(in srgb,var(--clay) 60%,transparent)}
.cdx-chip.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 60%,transparent)}
.cdx-chip.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 60%,transparent)}
.cdx-chip.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 60%,transparent)}
.cdx-side{display:flex;align-items:center;gap:4px;justify-self:end}
.cdx-acts{display:flex;align-items:center;gap:0;opacity:0;transition:opacity 120ms var(--ease)}
.cdx-row:hover .cdx-acts,.cdx-row:focus-within .cdx-acts,.cdx-row.open .cdx-acts{opacity:1}
@media (hover:none){.cdx-acts{opacity:1}}
.cdx-size{display:flex;flex-direction:column;align-items:flex-end;gap:3px;width:52px}
.cdx-mini{display:block;width:44px;height:3px;background:var(--l2);box-shadow:inset 0 0 0 1px var(--line1)}
.cdx-mini>i{display:block;height:100%}
.cdx-check{display:inline-flex;align-items:center;justify-content:center;width:22px;height:24px;margin:-2px -4px;cursor:pointer}
.cdx input[type=checkbox]{-webkit-appearance:none;appearance:none;display:inline-grid;place-content:center;flex:none;margin:0;width:14px;height:14px;
  border:1px solid var(--ink3);background:transparent;cursor:pointer;transition:background-color 120ms var(--ease),border-color 120ms var(--ease)}
.cdx input[type=checkbox]::before{content:"";width:8px;height:8px;transform:scale(0);background:var(--on-clay);
  clip-path:polygon(14% 44%,0 65%,50% 100%,100% 16%,80% 0%,43% 62%)}
.cdx input[type=checkbox]:hover:not(:disabled){border-color:var(--ink)}
.cdx input[type=checkbox]:checked,.cdx input[type=checkbox]:indeterminate{background:var(--clay);border-color:var(--clay)}
.cdx input[type=checkbox]:checked::before{transform:scale(1)}
.cdx input[type=checkbox]:indeterminate::before{transform:scale(1);height:2px;clip-path:none}
.cdx input[type=checkbox]:disabled{cursor:not-allowed;opacity:.35;border-style:dotted}
.cdx input[type=checkbox]:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.cdx-detail{grid-column:2 / -1;padding:4px 0 4px;display:flex;flex-direction:column;gap:6px;cursor:default}
.cdx-pre{margin:0;font-family:var(--mono);font-size:11px;line-height:1.5;background:var(--l2);border:1px solid var(--line1);padding:6px 8px;overflow:auto;max-height:260px;white-space:pre-wrap;word-break:break-word;color:var(--ink)}
.cdx-pre.short{max-height:9.2em}
.cdx-pre.log{white-space:pre;max-height:260px}
.cdx-text{font-size:12.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--ink)}
.cdx-btnrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}

/* context section */
.cdx-tools{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:6px;padding:4px 10px 4px 12px;background:var(--l1);border-bottom:1px solid var(--line1);min-height:34px;flex-wrap:wrap}
.cdx-tools label{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink2);cursor:pointer}
.cdx-foot{position:sticky;bottom:0;z-index:3;display:flex;align-items:center;gap:8px;padding:8px 10px 8px 12px;background:var(--l3);border-top:1px solid var(--line);box-shadow:0 -6px 0 -5px rgba(0,0,0,.08)}
.cdx-foot .cdx-num{color:var(--ink)}
.cdx-more{display:flex;justify-content:center;padding:6px 12px 10px}

/* forms */
.cdx-in{font:inherit;font-size:12px;line-height:16px;padding:5px 8px;border:1px solid var(--line);background:var(--base);color:var(--ink);min-height:28px;width:100%;resize:vertical}
.cdx-in:focus{outline:2px solid var(--blue);outline-offset:-1px}
select.cdx-in{width:auto;padding-right:4px}
.cdx-in.s{min-height:24px;padding:2px 6px;font-size:11.5px}
.cdx-form{display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;border-bottom:1px solid var(--line1);background:var(--l2)}
.cdx-field{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.cdx-field>span{font-size:11px;color:var(--ink2)}
.cdx-frow{display:flex;gap:8px;flex-wrap:wrap}
.cdx-radio{display:flex;flex-direction:column;gap:4px}
.cdx-radio label{display:flex;align-items:flex-start;gap:6px;font-size:12px;color:var(--ink);cursor:pointer;line-height:1.4}
.cdx-radio input{accent-color:var(--clay);margin:2px 0 0}
.cdx-help{font-size:11px;color:var(--ink3);line-height:1.45}

/* states */
.cdx-empty{padding:12px 14px 14px;color:var(--ink2);font-size:12px;line-height:1.5}
.cdx-empty b{display:block;color:var(--ink);font-weight:600;font-size:12.5px;margin-bottom:2px}
.cdx-empty-act{margin-top:8px}
.cdx-note{margin:8px 12px;padding:8px 10px;border:1px solid var(--line);border-left-width:3px;background:var(--l2);font-size:12px;line-height:1.5}
.cdx-note.bad{border-left-color:var(--bad)}.cdx-note.warn{border-left-color:var(--warn)}.cdx-note.ok{border-left-color:var(--ok)}
.cdx-note .cdx-btnrow{margin-top:6px}
.cdx-skel{height:26px;margin:4px 12px;background:var(--l2);animation:cdx-skel 1.2s ease-in-out infinite}
@keyframes cdx-skel{50%{opacity:.45}}
.cdx-center{padding:24px 16px;color:var(--ink2);line-height:1.5}

/* versions and epochs */
.cdx-diff{font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;padding:6px 8px;background:var(--l2);border:1px solid var(--line1);max-height:280px;overflow:auto}
.cdx-diff ins{text-decoration:underline;text-decoration-color:var(--ok);text-underline-offset:2px;background:color-mix(in srgb,var(--ok) 20%,transparent);color:var(--ink)}
.cdx-diff del{text-decoration:line-through;text-decoration-color:var(--bad);background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--ink2)}
.cdx-vlist{display:flex;flex-direction:column}
.cdx-vrow{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:26px;padding:2px 6px;font-size:12px;cursor:pointer;color:var(--ink2)}
.cdx-vrow:hover{background:var(--hov)}
.cdx-vrow[aria-pressed=true]{background:var(--sel);color:var(--ink);box-shadow:inset 2px 0 0 var(--clay)}
.cdx-vrow:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}

/* toasts */
.cdx-toasts{position:absolute;left:10px;right:10px;bottom:10px;z-index:20;display:flex;flex-direction:column-reverse;gap:8px;pointer-events:none}
.cdx-toast{pointer-events:auto;position:relative;display:flex;align-items:center;gap:8px;padding:8px 6px 10px 12px;background:var(--l3);color:var(--ink);
  border:1px solid var(--line);box-shadow:var(--pop);font-size:12.5px;line-height:1.45;animation:cdx-in 160ms var(--ease)}
.cdx-toast.bad{border-left:3px solid var(--bad)}
.cdx-toast .cdx-grow{overflow-wrap:anywhere}
.cdx-toast-bar{position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--clay);transform-origin:left center;animation:cdx-shrink linear forwards}
.cdx-toast.paused .cdx-toast-bar{animation-play-state:paused}
@keyframes cdx-shrink{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@keyframes cdx-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

/* star in the assistant message action row */
.cdx-star{display:inline-flex;align-items:center}
.cdx-star button{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));display:inline-flex;align-items:center;justify-content:center;
  padding:6px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:var(--dsw-radius-sm,0)}
.cdx-star button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.cdx-star button[aria-pressed=true]{color:var(--tz-accent,var(--dsw-alias-brand-primary,#c1553a))}
.cdx-star button:disabled{opacity:.4;cursor:default}
.cdx-star button:focus-visible{outline:2px solid var(--tz-accent-2,#5e9bd6);outline-offset:1px}
.cdx-star-msg{font-size:12px;color:var(--dsw-alias-label-tertiary);padding-left:4px}

/* main chat: edited messages and ghosts (outside the .cdx root: tokens with fallbacks) */
.cdx-edited.user{display:flex;flex-direction:column}
.cdx-edited.user>.cdx-vmark{align-self:flex-end;margin:2px 0 0}
.cdx-vmark{position:relative;display:inline-flex;align-items:center;height:calc(28px + var(--dsh-content-font-delta,0px))}
.cdx-vchip{font:inherit;font-family:var(--tz-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px;padding:1px 6px;margin:0 2px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;border-radius:var(--dsw-radius-sm,0)}
.cdx-vchip:hover,.cdx-vchip[aria-expanded=true]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--tz-accent,var(--dsw-alias-brand-primary,#c1553a))}
.cdx-vchip:focus-visible{outline:2px solid var(--tz-accent-2,#5e9bd6);outline-offset:1px}
.cdx-vpop{position:absolute;z-index:60;bottom:calc(100% + 6px);left:0;width:min(380px,80vw);max-height:min(420px,60vh);overflow:auto;display:flex;flex-direction:column;
  padding:4px 0;text-align:left;font-size:12.5px;line-height:1.45;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-3,#2a2523);
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));box-shadow:var(--tz-shadow-pop,0 8px 24px rgba(0,0,0,.25));border-radius:var(--dsw-radius-lg,0)}
.cdx-vmark.end .cdx-vpop{left:auto;right:0}
.cdx-vpop.down{bottom:auto;top:calc(100% + 6px)}
.cdx-vpop-row{display:flex;flex-direction:column;gap:3px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}
.cdx-vpop-row:last-of-type{border-bottom:0}
.cdx-vpop-head{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary,inherit);font-size:11.5px}
.cdx-vpop-head b{font-family:var(--tz-font-mono,ui-monospace,monospace);color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.cdx-vpop-head>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cdx-vpop-cur{flex:none!important;color:var(--tz-accent,#c1553a)}
.cdx-vpop-btn,.cdx-vpop-link{font:inherit;font-size:11.5px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:transparent;color:inherit;cursor:pointer}
.cdx-vpop-btn:hover,.cdx-vpop-link:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.cdx-vpop-link{align-self:flex-start;margin:6px 12px 4px;border-color:transparent;color:var(--dsw-alias-link,var(--tz-accent-2,#5e9bd6));padding:1px 0}
.cdx-vpop-text{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,inherit);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.cdx-vpop-note{padding:6px 12px;color:var(--dsw-alias-label-secondary,inherit)}
.cdx-ghost{display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin:2px 0}
.cdx-ghost-meta{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit)}
.cdx-ghost-from{font-weight:600;color:var(--dsw-alias-label-secondary,inherit);max-width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cdx-ghost-time{font-variant-numeric:tabular-nums}
.cdx-ghost-tag,.cdx-ghost-kind{font:inherit;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;line-height:16px;padding:0 6px;background:transparent;border:1px dashed currentColor;border-radius:var(--dsw-radius-sm,0)}
.cdx-ghost-tag{color:var(--tz-accent-2,#5e9bd6);cursor:pointer}
.cdx-ghost-tag:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.cdx-ghost-tag:focus-visible{outline:2px solid var(--tz-accent-2,#5e9bd6);outline-offset:1px}
.cdx-ghost-kind{border-style:solid;color:var(--dsw-alias-state-success-primary,#4f9d69)}
.cdx-ghost-kind.alert{color:var(--dsw-alias-state-error-primary,#e0685a)}
.cdx-ghost-bubble{max-width:min(calc(var(--dsh-chat-content-width,748px) * .8),92%);padding:10px 16px;color:var(--dsw-alias-label-primary,inherit);
  font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;overflow-wrap:anywhere;
  border:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:color-mix(in srgb,var(--dsw-specific-bubble,rgba(128,128,128,.08)) 55%,transparent);border-radius:var(--dsw-radius-xl,0)}

.cdx-rewound{display:flex;align-items:center;gap:10px;margin:6px 0;color:var(--dsw-alias-label-tertiary,inherit)}
.cdx-rewound-line{flex:1;height:0;border-top:1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.35))}
.cdx-rewound-text{font:inherit;font-size:12px;line-height:18px;padding:0 4px;border:0;background:transparent;color:inherit;cursor:pointer;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cdx-rewound-text:hover:not(:disabled){color:var(--dsw-alias-label-secondary,inherit)}
.cdx-rewound-text:focus-visible{outline:2px solid var(--tz-accent-2,#5e9bd6);outline-offset:1px}

/* settings page section */
.cdx-set{${VARS};font-size:13px;line-height:1.45;color:var(--ink);max-width:760px}
.cdx-set .cdx-note{margin:0 0 14px}
.cdx-sgroup{margin:0 0 18px;border-top:1px solid var(--line)}
.cdx-sgroup>h4{margin:0;padding:10px 0 6px;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)}
.cdx-srow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line1)}
.cdx-srow .t{font-size:13px;color:var(--ink)}
.cdx-srow .d{font-size:11.5px;color:var(--ink3);margin-top:1px}
.cdx-srow .cdx-in{width:220px}
.cdx-srow .cdx-in.n{width:110px;text-align:right}
.cdx-switch{all:unset;box-sizing:border-box;position:relative;display:inline-block;width:34px;height:18px;border:1px solid var(--line);background:var(--l2);cursor:pointer;flex:none}
.cdx-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;background:var(--ink3);transition:transform 120ms var(--ease)}
.cdx-switch[aria-checked=true]{background:var(--clay);border-color:var(--clay)}
.cdx-switch[aria-checked=true]::after{transform:translateX(16px);background:var(--on-clay)}
.cdx-switch:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.cdx-card{border:1px solid var(--line1);padding:8px 10px;margin:8px 0;background:var(--l2)}
.cdx-sbar{position:sticky;bottom:0;display:flex;gap:8px;align-items:center;padding:10px 0;z-index:5;background:var(--l1);border-top:1px solid var(--line)}

@media (prefers-reduced-motion:reduce){
  .cdx *,.cdx-set *{transition:none!important;animation:none!important}
  .cdx-indet::before{left:0;width:100%;opacity:.6}
}
`;
function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// src/client/header.jsx
var import_react5 = __toESM(require("react"), 1);

// src/client/format.js
function fmtTokens(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1e3) return String(Math.round(n));
  if (n < 1e5) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  if (n < 1e6) return Math.round(n / 1e3) + "K";
  return (n / 1e6).toFixed(2).replace(/0$/, "") + "M";
}
function spokenTokens(n) {
  if (!Number.isFinite(n)) return "an unknown number of";
  if (n < 1e3) return String(Math.round(n));
  if (n < 1e6) return Math.round(n / 1e3) + " thousand";
  return (n / 1e6).toFixed(1).replace(/\.0$/, "") + " million";
}
function plural(n, one, many) {
  return n === 1 ? one : many || one + "s";
}
function toMs(value) {
  if (value === null || value === void 0 || value === "") return NaN;
  if (typeof value === "number") return value;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : NaN;
}
function fmtAgo(value, now = Date.now()) {
  const t = toMs(value);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1e3));
  if (s < 10) return "now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 172800) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}
function fmtClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1e3));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + ss : m + ":" + ss;
}
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtWhen(value, now = Date.now()) {
  const t = toMs(value);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const n = new Date(now);
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, n)) return "today " + hm;
  const y = new Date(now - 864e5);
  if (sameDay(d, y)) return "yesterday " + hm;
  return MONTHS[d.getMonth()] + " " + d.getDate() + " " + hm;
}
function fmtHM(value) {
  const t = toMs(value);
  if (!Number.isFinite(t)) return "--:--";
  const d = new Date(t);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function firstLine(text, max = 140) {
  const s = String(text || "").trim().split(/\r?\n/).find((l) => l.trim()) || "";
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "\u2026" : s;
}
function excerpt(text, max = 140) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "\u2026" : s;
}
function shortId(id) {
  const s = String(id || "");
  return s.length > 22 ? s.slice(0, 14) + "\u2026" + s.slice(-4) : s;
}
var GROUPS = [
  { id: "system", label: "System and tools", color: "var(--c-system)", cats: ["system", "tools"] },
  { id: "instructions", label: "Instructions", color: "var(--c-instr)", cats: ["context"] },
  { id: "handoff", label: "Handoff", color: "var(--c-handoff)", cats: ["checkpoint"] },
  { id: "messages", label: "Messages", color: "var(--c-msg)", cats: ["user", "assistant", "conductor"] },
  { id: "tools", label: "Tool results", color: "var(--c-tool)", cats: ["tool"] }
];
var GROUP_OF = {};
for (const g of GROUPS) for (const c of g.cats) GROUP_OF[c] = g;
function groupOf(category) {
  return GROUP_OF[category] || GROUPS[3];
}
function kindLabel(item) {
  switch (item && item.category) {
    case "system":
      return "System prompt";
    case "tool":
      return "Tool result";
    case "assistant":
      return "Assistant";
    case "user":
      return "You";
    case "conductor":
      return "Conductor notice";
    case "checkpoint":
      return "Handoff";
    case "context":
      return "Instructions";
    default:
      return "Item";
  }
}
function meterModel(meter) {
  const cats = meter && meter.categories || {};
  const total = Number(meter && meter.total) || 0;
  const win = Number(meter && meter.window) || 0;
  const segments = GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    color: g.color,
    tokens: g.cats.reduce((sum, c) => sum + (Number(cats[c]) || 0), 0)
  }));
  const percent = win > 0 ? Math.min(100, Math.round(total / win * 100)) : null;
  return { total, window: win || null, percent, free: win > 0 ? Math.max(0, win - total) : null, segments };
}
function meterLevel(percent, warnPercent = 80) {
  if (percent === null || percent === void 0) return "ok";
  if (percent >= warnPercent) return "bad";
  if (percent >= Math.max(0, warnPercent - 20)) return "warn";
  return "ok";
}
function dropBlocker(item) {
  if (!item) return "Unknown item.";
  if (item.pinned) return "Pinned. Unpin to drop.";
  if (item.pendingDrop) return "Already queued: it leaves the context when the next turn starts.";
  if (item.dropped) return "Already dropped.";
  if (item.index === 0 || item.category === "system") return "The system prompt is never dropped.";
  if (!item.droppable) return item.category === "checkpoint" ? "The handoff stays until the next reset." : "This item cannot be dropped.";
  return "";
}
function selectionTotal(items, selected) {
  const list = Array.isArray(items) ? items : [];
  const want = new Set([...selected || []].map(Number));
  const order = list.map((i) => i.seq);
  const bySeq = new Map(list.map((i) => [i.seq, i]));
  const covered = /* @__PURE__ */ new Set();
  const seqs = [];
  for (const seq2 of order) {
    if (!want.has(seq2)) continue;
    const item = bySeq.get(seq2);
    if (!item || dropBlocker(item)) continue;
    seqs.push(seq2);
    covered.add(seq2);
    if (item.category === "assistant") {
      for (let i = order.indexOf(seq2) + 1; i < order.length; i += 1) {
        const next = bySeq.get(order[i]);
        if (!next || next.category !== "tool") break;
        covered.add(next.seq);
      }
    }
  }
  let tokens = 0;
  for (const s of covered) tokens += Number(bySeq.get(s).tokens) || 0;
  return { count: seqs.length, tokens, seqs, expanded: [...covered].sort((a, b) => a - b) };
}
function sortItems(items, mode) {
  const list = [...items || []];
  if (mode === "age") return list.sort((a, b) => a.seq - b.seq);
  if (mode === "newest") return list.sort((a, b) => b.seq - a.seq);
  if (mode === "type") {
    const rank = (i) => GROUPS.indexOf(groupOf(i.category));
    return list.sort((a, b) => rank(a) - rank(b) || b.tokens - a.tokens);
  }
  return list.sort((a, b) => b.tokens - a.tokens || a.seq - b.seq);
}
function dropMessage(result) {
  const r = result || {};
  const dropped = Number(r.dropped) || 0;
  const queued = Number(r.queued) || 0;
  const parts = [];
  if (dropped > 0) parts.push("Dropped " + dropped + " " + plural(dropped, "item") + ".");
  if (queued > 0) parts.push(queued + " tool " + plural(queued, "output") + " " + (queued === 1 ? "leaves" : "leave") + " the context when the next turn starts.");
  if (parts.length && Number.isFinite(r.tokens)) parts.push(fmtTokens(r.tokens) + " tokens freed.");
  const steps = dropped - (Array.isArray(r.undoable) ? r.undoable.length : dropped);
  if (steps > 0) parts.push(steps === 1 ? "The assistant step cannot be put back; its original is saved." : steps + " assistant steps cannot be put back; their originals are saved.");
  if (!parts.length) return r.text || "Nothing was dropped.";
  const skipped = Array.isArray(r.skipped) ? r.skipped : [];
  if (skipped.length) {
    const reasons = [...new Set(skipped.map((s) => s && s.reason).filter(Boolean))];
    parts.push("Skipped " + skipped.length + (reasons.length ? ": " + reasons.join("; ") : "") + ".");
  }
  return parts.join(" ");
}
function wordDiff(a, b, limit = 1600) {
  const A = String(a || "").split(/(\s+)/).filter((t) => t !== "");
  const B = String(b || "").split(/(\s+)/).filter((t) => t !== "");
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start += 1;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const out = [];
  const push = (type, text) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  push("same", A.slice(0, start).join(""));
  const midA = A.slice(start, endA);
  const midB = B.slice(start, endB);
  if (midA.length > limit || midB.length > limit) {
    push("del", midA.join(""));
    push("add", midB.join(""));
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i2 = n - 1; i2 >= 0; i2 -= 1) {
      for (let j2 = m - 1; j2 >= 0; j2 -= 1) {
        dp[i2][j2] = midA[i2] === midB[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        push("same", midA[i]);
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        push("del", midA[i]);
        i += 1;
      } else {
        push("add", midB[j]);
        j += 1;
      }
    }
    while (i < n) {
      push("del", midA[i]);
      i += 1;
    }
    while (j < m) {
      push("add", midB[j]);
      j += 1;
    }
  }
  push("same", A.slice(endA).join(""));
  return groupChanges(out);
}
function groupChanges(parts) {
  const out = [];
  let del = "";
  let add = "";
  let changed = false;
  let pendingWs = "";
  const flush = () => {
    if (changed) {
      if (del) out.push({ type: "del", text: del });
      if (add) out.push({ type: "add", text: add });
    }
    del = "";
    add = "";
    changed = false;
  };
  const pushSame = (text) => {
    const last = out[out.length - 1];
    if (last && last.type === "same") last.text += text;
    else out.push({ type: "same", text });
  };
  for (const p of parts) {
    if (p.type === "same" && /^\s+$/.test(p.text) && changed) {
      pendingWs += p.text;
      continue;
    }
    if (p.type === "same") {
      flush();
      pushSame(pendingWs + p.text);
      pendingWs = "";
      continue;
    }
    if (pendingWs) {
      del += pendingWs;
      add += pendingWs;
      pendingWs = "";
    }
    changed = true;
    if (p.type === "del") del += p.text;
    else add += p.text;
  }
  flush();
  if (pendingWs) pushSame(pendingWs);
  return out;
}
function tokenDelta(a, b) {
  return Math.round((String(b || "").length - String(a || "").length) / 4);
}
function epochLabel(kind) {
  switch (kind) {
    case "new":
      return "/new";
    case "clear":
      return "/clear";
    case "force-compact":
      return "/force-compact";
    case "pointer":
      return "Pointer compaction";
    case "compact":
      return "Auto compaction";
    case "rewind":
      return "Rewind";
    default:
      return String(kind || "Reset");
  }
}
function byLabel(by) {
  if (by === "model") return "by the assistant";
  if (by === "auto") return "automatic";
  if (by === "script") return "by a script";
  if (by === "schedule") return "scheduled";
  if (by === "recovery") return "by recovery";
  return "by you";
}
function resetTitle(kind) {
  switch (kind) {
    case "new":
      return "Writing handoff";
    case "clear":
      return "Clearing context";
    case "pointer":
      return "Writing a pointer checkpoint";
    default:
      return "Compacting context";
  }
}

// src/client/sections/automation.jsx
var import_react4 = __toESM(require("react"), 1);
var DEFAULT_HANDOFF_TEMPLATE = [
  "# Handoff",
  "## 1. Role and standing orders",
  "- [who you are in this chat; the user's standing instructions, preferences and constraints, quoted verbatim where the wording matters]",
  "## 2. Goal and current state",
  "- [the overall goal, and precisely where the work stands now]",
  "## 3. Decisions made",
  "- [decision: reason; alternatives rejected]",
  "## 4. Open items and pending requests",
  "- [everything requested and not yet done; quote the user's most recent requests verbatim]",
  "## 5. Files, paths, services, commands",
  "- [exact paths, ids, URLs, commands and their purpose]",
  "## 6. Running work",
  "- [subagents, background jobs, schedules or other chats still working: ids, what they do, where results will land]",
  "## 7. Gotchas",
  "- [what failed and why, traps to avoid, things verified not to work]",
  "## 8. Next step",
  "- [the single next action, in line with the most recent request]"
].join("\n");
function levelPhrase(level) {
  if (!level) return "";
  if (level.paused || level.source === "paused") return "Auto level paused";
  if (!level.percent) return "";
  return (level.action === "handoff" ? "Auto handoff" : "Auto compact") + " at " + level.percent + "%";
}
function automationSummary(view) {
  if (!view) return "";
  const parts = [];
  const lp = levelPhrase(view.level);
  if (lp) parts.push(lp);
  const a = view.autoNew;
  if (a && a.daily) parts.push("/new daily " + a.daily);
  else if (a && a.everyTurns) parts.push("/new every " + a.everyTurns + " turns");
  if (view.relay && view.relay.to) parts.push("answers to " + (view.relay.label || shortId(view.relay.to)));
  if (typeof view.handoffTemplate === "string" && view.handoffTemplate.trim()) parts.push("own handoff template");
  const r = view.recovery;
  if (r && r.waiting) parts.push("recovery retrying");
  return parts.join(" \xB7 ");
}
function Part({ title, children, note }) {
  return /* @__PURE__ */ import_react4.default.createElement("section", { className: "cdx-apart" }, /* @__PURE__ */ import_react4.default.createElement("h3", { className: "cdx-wsub" }, title), note ? /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-help" }, note) : null, children);
}
function useSaver(sessionId, model) {
  const [busy, setBusy] = (0, import_react4.useState)("");
  const save = async (key, fn, okText) => {
    setBusy(key);
    try {
      const r = await fn();
      toast({ message: r && r.text || okText, sessionId });
      return r;
    } catch (e) {
      toastError("Could not save.", e, sessionId);
      return null;
    } finally {
      setBusy("");
      model.refresh().catch(() => {
      });
    }
  };
  return [busy, save];
}
function LevelPart({ view, api, model, sessionId }) {
  const level = view.level || { percent: 0, action: "compact", source: "default", nudge: true };
  const custom = level.source === "chat";
  const [percent, setPercent] = (0, import_react4.useState)(custom ? level.percent : 50);
  const [action, setAction] = (0, import_react4.useState)(level.action || "compact");
  const [busy, save] = useSaver(sessionId, model);
  const timer = (0, import_react4.useRef)(null);
  (0, import_react4.useEffect)(() => {
    if (custom) {
      setPercent(level.percent);
      setAction(level.action);
    }
  }, [level.percent, level.action, custom]);
  (0, import_react4.useEffect)(() => () => clearTimeout(timer.current), []);
  const commit = (p, a) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save("level", () => api.level({ percent: p, action: a }), "Automatic level saved."), 450);
  };
  const inherited = level.source === "global" ? (level.action === "handoff" ? "Hand off" : "Compact") + " at " + level.percent + "% (all chats)" : "DSH default (compacts at about 80%)";
  return /* @__PURE__ */ import_react4.default.createElement(Part, { title: "Automatic level", note: "When this chat compacts or starts a fresh context by itself." }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-radio", role: "radiogroup", "aria-label": "Automatic level" }, /* @__PURE__ */ import_react4.default.createElement("label", null, /* @__PURE__ */ import_react4.default.createElement(
    "input",
    {
      type: "radio",
      name: "cdx-lvl-" + sessionId,
      checked: !custom,
      disabled: busy === "level",
      onChange: () => save("level", () => api.level({ off: true }), "Back to the default level.")
    }
  ), "Default: " + inherited), /* @__PURE__ */ import_react4.default.createElement("label", null, /* @__PURE__ */ import_react4.default.createElement(
    "input",
    {
      type: "radio",
      name: "cdx-lvl-" + sessionId,
      checked: custom,
      disabled: busy === "level",
      onChange: () => save("level", () => api.level({ percent, action }), "Automatic level saved.")
    }
  ), "Custom for this chat")), custom ? /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-acustom" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react4.default.createElement(
    "input",
    {
      type: "range",
      min: 10,
      max: 95,
      step: 5,
      value: percent,
      "aria-label": "Level, percent of the model window",
      "data-level-slider": true,
      onChange: (e) => {
        const p = Number(e.target.value);
        setPercent(p);
        commit(p, action);
      },
      style: { flex: 1, accentColor: "var(--clay)" }
    }
  ), /* @__PURE__ */ import_react4.default.createElement("span", { className: "cdx-num", style: { width: 36, textAlign: "right" } }, percent + "%")), /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-radio", role: "radiogroup", "aria-label": "What happens at the level", style: { flexDirection: "row", gap: 16 } }, /* @__PURE__ */ import_react4.default.createElement("label", null, /* @__PURE__ */ import_react4.default.createElement("input", { type: "radio", name: "cdx-act-" + sessionId, checked: action === "compact", onChange: () => {
    setAction("compact");
    commit(percent, "compact");
  } }), "Compact"), /* @__PURE__ */ import_react4.default.createElement("label", null, /* @__PURE__ */ import_react4.default.createElement("input", { type: "radio", name: "cdx-act-" + sessionId, checked: action === "handoff", onChange: () => {
    setAction("handoff");
    commit(percent, "handoff");
  } }), "Hand off"))) : null, /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-wrow" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-grow" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "t" }, "Heads-up before the level"), /* @__PURE__ */ import_react4.default.createElement("div", { className: "d" }, "The assistant is told once, so it can finish its step and write things down.")), /* @__PURE__ */ import_react4.default.createElement(Switch, { checked: level.nudge !== false, label: "Heads-up before the level", onChange: (v) => save("nudge", () => api.level({ nudge: v }), v ? "Heads-up on." : "Heads-up off.") })), /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-wrow" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-grow" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "t" }, "Pause for this chat"), /* @__PURE__ */ import_react4.default.createElement("div", { className: "d" }, "DSH's own default applies while paused.")), /* @__PURE__ */ import_react4.default.createElement(Switch, { checked: Boolean(level.paused), label: "Pause the automatic level for this chat", onChange: (v) => save("pause", () => api.level({ paused: v }), v ? "Paused for this chat." : "Resumed.") })));
}
function AutoNewPart({ view, api, model, sessionId }) {
  const a = view.autoNew || null;
  const mode = a && a.daily ? "daily" : a && a.everyTurns ? "turns" : "off";
  const [pick, setPick] = (0, import_react4.useState)(mode);
  const [time, setTime] = (0, import_react4.useState)(a && a.daily || "03:00");
  const [turns, setTurns] = (0, import_react4.useState)(a && a.everyTurns || 40);
  const [busy, save] = useSaver(sessionId, model);
  (0, import_react4.useEffect)(() => {
    setPick(mode);
  }, [mode]);
  const apply2 = () => {
    if (pick === "off") return save("auto", () => api.autoNew({ off: true }), "Scheduled /new off.");
    if (pick === "daily") return save("auto", () => api.autoNew({ daily: time }), "/new runs daily at " + time + ".");
    return save("auto", () => api.autoNew({ everyTurns: Number(turns) }), "/new runs every " + turns + " turns.");
  };
  const changed = pick !== mode || pick === "daily" && time !== (a && a.daily) || pick === "turns" && Number(turns) !== (a && a.everyTurns);
  return /* @__PURE__ */ import_react4.default.createElement(Part, { title: "Scheduled /new", note: a && a.lastRun ? "Last run " + new Date(a.lastRun).toLocaleString() + "." : "A fresh context from a handoff, on a schedule." }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-radio", role: "radiogroup", "aria-label": "Scheduled /new" }, /* @__PURE__ */ import_react4.default.createElement("label", null, /* @__PURE__ */ import_react4.default.createElement("input", { type: "radio", name: "cdx-an-" + sessionId, checked: pick === "off", onChange: () => setPick("off") }), "Off"), /* @__PURE__ */ import_react4.default.createElement("label", null, /* @__PURE__ */ import_react4.default.createElement("input", { type: "radio", name: "cdx-an-" + sessionId, checked: pick === "daily", onChange: () => setPick("daily") }), "Daily at ", /* @__PURE__ */ import_react4.default.createElement("input", { className: "cdx-in s", type: "time", value: time, "aria-label": "Time of day", style: { width: 96, marginLeft: 6 }, onChange: (e) => {
    setTime(e.target.value);
    setPick("daily");
  } })), /* @__PURE__ */ import_react4.default.createElement("label", null, /* @__PURE__ */ import_react4.default.createElement("input", { type: "radio", name: "cdx-an-" + sessionId, checked: pick === "turns", onChange: () => setPick("turns") }), "Every ", /* @__PURE__ */ import_react4.default.createElement("input", { className: "cdx-in s", type: "number", min: 2, max: 1e3, value: turns, "aria-label": "Number of turns", style: { width: 64, margin: "0 6px" }, onChange: (e) => {
    setTurns(e.target.value);
    setPick("turns");
  } }), " turns")), a && a.pending ? /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-help" }, "A /new is waiting for the current turn to end.") : null, changed ? /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react4.default.createElement("button", { type: "button", className: "cdx-btn s p", "data-save-autonew": true, disabled: busy === "auto", onClick: apply2 }, "Save")) : null);
}
function RelayPart({ view, api, model, sessionId }) {
  const status = useSignal(statusModel);
  (0, import_react4.useEffect)(() => {
    if (!status.data) refreshStatus();
  }, []);
  const rows = (0, import_react4.useMemo)(() => (status.data && status.data.agents && status.data.agents.rows || []).filter((r) => r.sessionId !== sessionId), [status.data, sessionId]);
  const current = view.relay && view.relay.to || "";
  const [busy, save] = useSaver(sessionId, model);
  return /* @__PURE__ */ import_react4.default.createElement(Part, { title: "Relay final answers", note: "Each final answer of this chat lands in another chat as a ghost (it does not wake it)." }, /* @__PURE__ */ import_react4.default.createElement(
    "select",
    {
      className: "cdx-in",
      style: { width: "100%" },
      "aria-label": "Relay final answers to",
      value: current,
      disabled: busy === "relay",
      "data-relay": true,
      onChange: (e) => save("relay", () => api.relay(e.target.value || null), e.target.value ? "Final answers now go to that chat." : "Relay off.")
    },
    /* @__PURE__ */ import_react4.default.createElement("option", { value: "" }, "Off"),
    current && !rows.some((r) => r.sessionId === current) ? /* @__PURE__ */ import_react4.default.createElement("option", { value: current }, view.relay && view.relay.label || shortId(current)) : null,
    rows.map((r) => /* @__PURE__ */ import_react4.default.createElement("option", { key: r.sessionId, value: r.sessionId }, (r.title || "(untitled)") + " \xB7 " + shortId(r.sessionId)))
  ));
}
function TemplatePart({ view, api, model, sessionId }) {
  const own = typeof view.handoffTemplate === "string" && view.handoffTemplate.trim() ? view.handoffTemplate : "";
  const [custom, setCustom] = (0, import_react4.useState)(Boolean(own));
  const [text, setText] = (0, import_react4.useState)(own);
  const [busy, save] = useSaver(sessionId, model);
  (0, import_react4.useEffect)(() => {
    setCustom(Boolean(own));
    setText(own);
  }, [own]);
  return /* @__PURE__ */ import_react4.default.createElement(Part, { title: "Handoff template", note: "The sections the assistant fills in when it hands off (/new)." }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-radio", role: "radiogroup", "aria-label": "Handoff template" }, /* @__PURE__ */ import_react4.default.createElement("label", null, /* @__PURE__ */ import_react4.default.createElement("input", { type: "radio", name: "cdx-tpl-" + sessionId, checked: !custom, onChange: () => {
    setCustom(false);
    if (own) save("tpl", () => api.template(""), "Back to the default template.");
  } }), "Default"), /* @__PURE__ */ import_react4.default.createElement("label", null, /* @__PURE__ */ import_react4.default.createElement("input", { type: "radio", name: "cdx-tpl-" + sessionId, checked: custom, onChange: () => setCustom(true) }), "Custom for this chat")), custom ? /* @__PURE__ */ import_react4.default.createElement(import_react4.default.Fragment, null, /* @__PURE__ */ import_react4.default.createElement(
    "textarea",
    {
      className: "cdx-in",
      rows: 8,
      value: text,
      "aria-label": "Handoff template for this chat",
      "data-template": true,
      placeholder: "Markdown sections, for example ## Goal, ## Decisions, ## Next step",
      onChange: (e) => setText(e.target.value)
    }
  ), /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react4.default.createElement("button", { type: "button", className: "cdx-btn s p", disabled: busy === "tpl" || !text.trim() || text === own, onClick: () => save("tpl", () => api.template(text), "Template saved for this chat.") }, "Save template"), /* @__PURE__ */ import_react4.default.createElement("button", { type: "button", className: "cdx-btn s g", "data-template-default": true, onClick: () => setText(DEFAULT_HANDOFF_TEMPLATE) }, "Start from the default"))) : /* @__PURE__ */ import_react4.default.createElement("pre", { className: "cdx-pre short", "aria-label": "Default handoff template" }, DEFAULT_HANDOFF_TEMPLATE));
}
function RecoveryPart({ view, api, model, sessionId }) {
  const r = view.recovery;
  const [busy, save] = useSaver(sessionId, model);
  if (!r) return /* @__PURE__ */ import_react4.default.createElement(Part, { title: "Recovery" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-help" }, "Recovery is not available in this build."));
  const line = r.conflict ? null : [r.enabled ? "On" : "Off", r.attempts ? r.attempts + " of " + r.maxAttempts + " " + plural(r.maxAttempts, "attempt") + " used" : "", r.waiting ? "waiting to retry" : "", r.fallback ? "fallback model " + r.fallback : ""].filter(Boolean).join(" \xB7 ");
  return /* @__PURE__ */ import_react4.default.createElement(Part, { title: "Recovery", note: "Resumes this chat after a failed, cut-off or crashed turn." }, r.conflict ? /* @__PURE__ */ import_react4.default.createElement(Note, { tone: "warn" }, "Off because dsh-continue is still installed; the migration replaces it.") : /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-wrow" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-grow" }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "t" }, "Recover this chat"), /* @__PURE__ */ import_react4.default.createElement("div", { className: "d", "data-recovery-status": true }, line)), /* @__PURE__ */ import_react4.default.createElement(
    Switch,
    {
      checked: !r.chatDisabled && r.enabled,
      label: "Recover this chat",
      disabled: busy === "rec",
      onChange: (v) => save("rec", () => api.recovery(v), v ? "Recovery on for this chat." : "Recovery off for this chat.")
    }
  )));
}
function AutomationPanel({ sessionId, view, api, model, onBack }) {
  return /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-auto", "data-automation": true }, /* @__PURE__ */ import_react4.default.createElement("div", { className: "cdx-phead" }, /* @__PURE__ */ import_react4.default.createElement("button", { type: "button", className: "cdx-link", "data-automation-back": true, onClick: onBack }, "Back"), /* @__PURE__ */ import_react4.default.createElement("span", { className: "cdx-help", style: { marginLeft: "auto" } }, "Automation for this chat")), /* @__PURE__ */ import_react4.default.createElement(LevelPart, { view, api, model, sessionId }), /* @__PURE__ */ import_react4.default.createElement(AutoNewPart, { view, api, model, sessionId }), /* @__PURE__ */ import_react4.default.createElement(RelayPart, { view, api, model, sessionId }), /* @__PURE__ */ import_react4.default.createElement(TemplatePart, { view, api, model, sessionId }), /* @__PURE__ */ import_react4.default.createElement(RecoveryPart, { view, api, model, sessionId }));
}

// src/client/header.jsx
function isCancelled(last) {
  return Boolean(last && !last.ok && /cancel/i.test(String(last.text || "")));
}
function Meter({ view, onFilter, onAutomation }) {
  const [open, setOpen] = (0, import_react5.useState)(false);
  const m = meterModel(view && view.meter);
  const warnPercent = pref("warnPercent");
  const level = meterLevel(m.percent, warnPercent);
  const parts = m.segments.filter((s) => s.tokens > 0);
  const label = "Context: " + spokenTokens(m.total) + (m.window ? " of " + spokenTokens(m.window) + " tokens used, " + m.percent + " percent." : " tokens.");
  const fill = m.window ? Math.max(0.5, Math.min(100, m.total / m.window * 100)) : 100;
  return /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-meter" }, /* @__PURE__ */ import_react5.default.createElement(
    "button",
    {
      type: "button",
      className: "cdx-mline",
      "aria-expanded": open,
      "aria-controls": "cdx-breakdown",
      "data-meter-numbers": true,
      title: open ? "Hide the breakdown" : "Show what fills the context",
      onClick: () => setOpen(!open)
    },
    /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-num" }, /* @__PURE__ */ import_react5.default.createElement("b", null, fmtTokens(m.total)), m.window ? " of " + fmtTokens(m.window) : " tokens"),
    m.percent !== null ? /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-pct " + level }, m.percent + "%") : null,
    /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-chev", "aria-hidden": "true", style: { transform: open ? "rotate(90deg)" : "none" } }, Icon.chevron(10))
  ), /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-thin " + level, role: "img", "aria-label": label, "data-meter-bar": true, title: parts.map((s) => s.label + " " + fmtTokens(s.tokens)).join(", ") }, /* @__PURE__ */ import_react5.default.createElement("i", { style: { width: fill.toFixed(2) + "%" } }), m.window && level !== "ok" ? /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-tick", style: { left: warnPercent + "%" }, "aria-hidden": "true" }) : null, view && view.level && view.level.percent && !view.level.paused ? /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-ltick", "data-level-tick": true, style: { left: view.level.percent + "%" }, title: levelPhrase(view.level), "aria-hidden": "true" }) : null), automationSummary(view) ? /* @__PURE__ */ import_react5.default.createElement("button", { type: "button", className: "cdx-asum", "data-automation-summary": true, onClick: onAutomation, title: "Open Automation" }, automationSummary(view)) : null, open ? /* @__PURE__ */ import_react5.default.createElement("ul", { className: "cdx-breakdown", id: "cdx-breakdown", "aria-label": "Context by category" }, parts.map((s) => /* @__PURE__ */ import_react5.default.createElement("li", { key: s.id }, /* @__PURE__ */ import_react5.default.createElement(
    "button",
    {
      type: "button",
      className: "cdx-brow",
      "data-seg": s.id,
      title: "Show only " + s.label.toLowerCase() + " in Context",
      onClick: () => {
        setOpen(false);
        onFilter(s.id);
      }
    },
    /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-sw", style: { background: s.color }, "aria-hidden": "true" }),
    /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-grow" }, s.label),
    /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-num" }, fmtTokens(s.tokens))
  ))), m.free !== null ? /* @__PURE__ */ import_react5.default.createElement("li", null, /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-brow muted" }, /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-sw", "aria-hidden": "true" }), /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-grow" }, "Free"), /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-num" }, fmtTokens(m.free)))) : null) : null, level === "bad" ? /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-hint", role: "note" }, "Context is " + m.percent + "% full. Start a new context to continue with a handoff.") : null);
}
function MoreMenu({ items, disabledTitle }) {
  const [open, setOpen] = (0, import_react5.useState)(false);
  const ref = (0, import_react5.useRef)(null);
  const btn = (0, import_react5.useRef)(null);
  (0, import_react5.useEffect)(() => {
    if (!open) return void 0;
    const first = ref.current && ref.current.querySelector("[role=menuitem]:not([aria-disabled=true])");
    if (first) first.focus();
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target) && btn.current && !btn.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const onKey = (e) => {
    const all = ref.current ? [...ref.current.querySelectorAll("[role=menuitem]")] : [];
    const i = all.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      if (btn.current) btn.current.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = all[(i + 1) % all.length];
      if (n) n.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = all[(i - 1 + all.length) % all.length];
      if (n) n.focus();
    }
  };
  return /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-menuwrap" }, /* @__PURE__ */ import_react5.default.createElement(
    "button",
    {
      type: "button",
      ref: btn,
      className: "cdx-ibtn",
      "aria-label": "More actions",
      title: "More actions",
      "aria-haspopup": "menu",
      "aria-expanded": open,
      "data-more": true,
      onClick: () => setOpen(!open)
    },
    Icon.more(16)
  ), open ? /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-menu", role: "menu", ref, onKeyDown: onKey }, items.map((it) => /* @__PURE__ */ import_react5.default.createElement(
    "button",
    {
      key: it.id,
      type: "button",
      role: "menuitem",
      className: "cdx-mitem" + (it.danger ? " d" : ""),
      "data-menu": it.id,
      "aria-disabled": it.disabled ? "true" : void 0,
      title: it.disabled ? disabledTitle : it.title,
      onClick: () => {
        if (it.disabled) return;
        setOpen(false);
        it.run();
      }
    },
    /* @__PURE__ */ import_react5.default.createElement("span", null, it.label),
    it.hint ? /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-mhint" }, it.hint) : null
  ))) : null);
}
function ResetBar({ view, fetchedAt, reset, onReset, onCancel, cancelling, onRefresh, refreshing, onDismissResult, resultDismissed, openFile, onSetup, onAutomation }) {
  const [confirm, setConfirm] = (0, import_react5.useState)(false);
  const progress = view && view.progress;
  const running = Boolean(progress) || Boolean(reset);
  const now = useNow(1e3, running);
  const engineOff = view && view.engine === "unavailable";
  const agentBusy = view && view.status === "running";
  const blocked = engineOff ? "The compaction hook is not installed, so resets are unavailable (see the server log)." : agentBusy ? "The agent is working. Try again when it finishes." : "";
  if (running) {
    const kind = progress && progress.kind || reset && reset.kind || "new";
    let elapsed = 0;
    if (progress) elapsed = (progress.elapsedMs || 0) + Math.max(0, now - (fetchedAt || now));
    else if (reset) elapsed = now - reset.at;
    return /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-progress", role: "status", "aria-live": "polite", "data-reset-progress": true }, /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-ptitle" }, /* @__PURE__ */ import_react5.default.createElement("span", null, progress ? resetTitle(kind) + "\u2026" : "Starting /" + kind + "\u2026"), /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-num", "aria-hidden": "true" }, fmtClock(elapsed))), /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-psub" }, kind === "new" ? elapsed > 1e4 ? "This usually takes under 90 seconds. Your context is unchanged until it finishes." : "Your context is unchanged until the handoff is written." : kind === "clear" ? "Archiving the context, then emptying it. Pins are kept." : "Your context is unchanged until the checkpoint is written."), progress && onCancel ? /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-actions", style: { marginTop: 8 } }, /* @__PURE__ */ import_react5.default.createElement("button", { type: "button", className: "cdx-btn s", "data-reset-cancel": true, disabled: cancelling, onClick: onCancel }, cancelling ? "Cancelling\u2026" : "Cancel")) : null, /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-indet", "aria-hidden": "true" }));
  }
  const last = view && view.lastReset;
  const epoch = last && last.ok && view.epochs && view.epochs[0] && view.epochs[0].kind === last.kind ? view.epochs[0] : null;
  const fresh = last && !resultDismissed && Date.now() - Date.parse(last.at) < 30 * 60 * 1e3;
  const cancelled = isCancelled(last);
  return /* @__PURE__ */ import_react5.default.createElement(import_react5.default.Fragment, null, confirm ? /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-confirm", role: "group", "aria-label": "Confirm clear" }, /* @__PURE__ */ import_react5.default.createElement("div", null, /* @__PURE__ */ import_react5.default.createElement("b", null, "Clear the model context?"), " The chat stays visible and is archived. Pins are kept. There is no undo."), /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-actions" }, /* @__PURE__ */ import_react5.default.createElement("button", { type: "button", className: "cdx-btn s", autoFocus: true, onClick: () => setConfirm(false) }, "Keep context"), /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-spacer" }), /* @__PURE__ */ import_react5.default.createElement("button", { type: "button", className: "cdx-btn s d", "data-confirm-clear": true, onClick: () => {
    setConfirm(false);
    onReset("clear");
  } }, "Clear context"))) : /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-actions" }, /* @__PURE__ */ import_react5.default.createElement(
    "button",
    {
      type: "button",
      className: "cdx-btn p",
      "data-reset": "new",
      disabled: Boolean(blocked) || !view,
      title: blocked || "Start fresh from a handoff the assistant writes (/new). Pins are kept.",
      onClick: () => onReset("new")
    },
    "New context"
  ), /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-spacer" }), refreshing ? /* @__PURE__ */ import_react5.default.createElement("span", { className: "cdx-help", "aria-live": "polite" }, "Refreshing") : null, /* @__PURE__ */ import_react5.default.createElement(MoreMenu, { disabledTitle: blocked, items: [
    { id: "clear", label: "Clear context", hint: "/clear", disabled: Boolean(blocked) || !view, title: "Empty the model context; the chat stays visible and archived.", run: () => setConfirm(true) },
    { id: "force-compact", label: "Compact", hint: "/force-compact", disabled: Boolean(blocked) || !view, title: "Summarise the conversation into a checkpoint.", run: () => onReset("force-compact") },
    ...onAutomation ? [{ id: "automation", label: "Automation", run: onAutomation }] : [],
    { id: "refresh", label: "Refresh", run: onRefresh },
    ...onSetup ? [{ id: "setup", label: "Run setup guide again", run: onSetup }] : []
  ] })), fresh ? /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-result" + (last.ok ? "" : cancelled ? " warn" : " bad"), role: last.ok || cancelled ? "status" : "alert", "data-reset-result": true }, /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-grow" }, /* @__PURE__ */ import_react5.default.createElement("div", null, last.ok ? firstLine(last.text, 240) : firstLine(last.text, 300) || "The reset failed. Your context is unchanged."), epoch && (epoch.handoff || epoch.archive) ? /* @__PURE__ */ import_react5.default.createElement("div", { className: "cdx-links" }, epoch.handoff ? /* @__PURE__ */ import_react5.default.createElement("button", { type: "button", className: "cdx-link", onClick: () => openFile(epoch.handoff) }, "View handoff") : null, epoch.archive ? /* @__PURE__ */ import_react5.default.createElement("button", { type: "button", className: "cdx-link", onClick: () => openFile(epoch.archive) }, "View archive") : null) : null), /* @__PURE__ */ import_react5.default.createElement("button", { type: "button", className: "cdx-ibtn", "aria-label": "Dismiss result", title: "Dismiss", onClick: onDismissResult }, Icon.close(12))) : null);
}

// src/client/sections/context.jsx
var import_react6 = __toESM(require("react"), 1);
var PAGE = 25;
var SIMPLE = 8;
function isEditable(item) {
  return Boolean(item.messageId) && !item.dropped && !item.pendingDrop && (item.category === "user" || item.category === "assistant");
}
async function undoDrop(api, model, result) {
  const parts = [];
  if (Array.isArray(result.undoable) && result.undoable.length) {
    const r = await api.undrop(result.undoable);
    const n = (r.restored || 0) + (r.queued || 0);
    if (n) parts.push("Put back " + n + " " + plural(n, "item") + ".");
  }
  if (result.queued > 0) {
    const r = await api.undrop("pending");
    const n = Number(r.cancelled) || 0;
    if (n) parts.push("Cancelled " + n + " queued " + plural(n, "drop") + ": nothing had left the context yet.");
  }
  model.refresh().catch(() => {
  });
  return parts.join(" ") || "Nothing to put back.";
}
function ItemDetail({ item, api, model, sessionId, onPinToggle }) {
  const [full, setFull] = (0, import_react6.useState)(null);
  const [loading, setLoading] = (0, import_react6.useState)(false);
  const [edit, setEdit] = (0, import_react6.useState)(null);
  const [saving, setSaving] = (0, import_react6.useState)(false);
  const text = full !== null ? full : item.preview || "";
  const truncated = full === null && (item.chars > (item.preview || "").length + 40 || (item.preview || "").length >= 240);
  const loadFull = async () => {
    setLoading(true);
    try {
      const r = await api.item(item.seq);
      setFull(String(r.text || ""));
      return String(r.text || "");
    } catch (e) {
      toastError("Could not load the full item.", e, sessionId);
      return null;
    } finally {
      setLoading(false);
    }
  };
  const startEdit = async () => {
    const t = full !== null ? full : await loadFull();
    if (t !== null) setEdit({ text: t, reason: "" });
  };
  const saveEdit = async () => {
    setSaving(true);
    try {
      const r = await api.edit(item.messageId, edit.text, edit.reason.trim() || void 0);
      toast({ message: "Saved version " + r.version + ". The model sees the new text from its next step; every version is kept in History.", sessionId });
      setEdit(null);
      setFull(null);
      model.refresh().catch(() => {
      });
    } catch (e) {
      toastError("Could not save the edit.", e, sessionId);
    } finally {
      setSaving(false);
    }
  };
  if (edit) {
    return /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-detail", onClick: (e) => e.stopPropagation(), onKeyDown: (e) => e.stopPropagation() }, /* @__PURE__ */ import_react6.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react6.default.createElement("span", null, "New text (the chat shows it with a version marker; every version is kept)"), /* @__PURE__ */ import_react6.default.createElement("textarea", { className: "cdx-in", rows: 6, value: edit.text, onChange: (e) => setEdit({ ...edit, text: e.target.value }), autoFocus: true })), /* @__PURE__ */ import_react6.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react6.default.createElement("span", null, "Reason (optional)"), /* @__PURE__ */ import_react6.default.createElement("input", { className: "cdx-in", value: edit.reason, onChange: (e) => setEdit({ ...edit, reason: e.target.value }), placeholder: "for example: removed a wrong assumption" })), /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-btn p s", disabled: saving || !edit.text.trim(), onClick: saveEdit }, saving ? "Saving\u2026" : "Save version"), /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => setEdit(null) }, "Cancel")));
  }
  return /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-detail", onClick: (e) => e.stopPropagation() }, text ? /* @__PURE__ */ import_react6.default.createElement("pre", { className: "cdx-pre" + (full === null ? " short" : ""), "data-preview": true }, full !== null && full.length > 2e5 ? full.slice(0, 2e5) : text) : /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-help" }, "No text content (tool calls or images only)."), /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-btnrow" }, truncated ? /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-btn s", disabled: loading, onClick: loadFull }, loading ? "Loading\u2026" : "Show all") : null, /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: async () => {
    const ok = await copyText(full !== null ? full : await loadFull() || text);
    toast({ message: ok ? "Copied " + kindLabel(item).toLowerCase() + " text." : "Copy is not available in this browser.", sessionId });
  } }, Icon.copy(13), "Copy"), item.messageId && (item.category === "user" || item.category === "assistant") && !item.dropped ? /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => onPinToggle(item) }, Icon.pin(13), item.pinned ? "Unpin" : "Pin") : null, isEditable(item) ? /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: startEdit }, Icon.edit(13), "Edit") : null));
}
function ItemRow({ item, max, ticked, focused, expanded, edited, onTick, onToggle, onFocusRow, rowRef, onUndrop, detail }) {
  const g = groupOf(item.category);
  const blocker = dropBlocker(item);
  const tickable = !blocker;
  const leaving = item.pendingDrop;
  const meta = [kindLabel(item)];
  if (item.tool && item.category === "tool") meta[0] = "Tool result";
  const age = fmtAgo(item.time);
  const title = item.label || "(empty)";
  return /* @__PURE__ */ import_react6.default.createElement("li", null, /* @__PURE__ */ import_react6.default.createElement(
    "div",
    {
      className: "cdx-row click" + (ticked ? " ticked" : "") + (item.dropped || leaving ? " gone" : "") + (expanded ? " open" : ""),
      ref: rowRef,
      tabIndex: focused ? 0 : -1,
      "data-seq": item.seq,
      "aria-expanded": expanded,
      onClick: onToggle,
      onFocus: onFocusRow,
      style: { gridTemplateColumns: "18px minmax(0,1fr) auto" }
    },
    /* @__PURE__ */ import_react6.default.createElement("label", { className: "cdx-check", onClick: (e) => e.stopPropagation(), title: blocker || void 0 }, /* @__PURE__ */ import_react6.default.createElement(
      "input",
      {
        type: "checkbox",
        checked: ticked,
        disabled: !tickable,
        tabIndex: -1,
        "aria-label": "Select " + title.slice(0, 80) + ", " + fmtTokens(item.tokens) + " tokens",
        onChange: () => onTick()
      }
    )),
    /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-main" }, /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-sw", style: { background: g.color }, "aria-hidden": "true" }), item.pinned ? /* @__PURE__ */ import_react6.default.createElement("span", { style: { color: "var(--clay)", display: "inline-flex" }, title: "Pinned", "aria-label": "Pinned" }, Icon.pin(12)) : null, /* @__PURE__ */ import_react6.default.createElement("span", { title }, title)), /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react6.default.createElement("span", null, meta.join(" \xB7 ") + (age ? " \xB7 " + age : "")), item.dropped ? /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-chip" }, "Dropped") : null, leaving ? /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-chip warn", title: "Tool outputs dropped between turns leave the context when the next turn starts." }, "Leaves at next turn") : null, edited ? /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-chip", title: "The model sees an edited version; see Versions." }, "Edited") : null)),
    /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-side" }, item.dropped && item.dropped.undoable ? /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-btn s", onClick: (e) => {
      e.stopPropagation();
      onUndrop(item);
    } }, "Undrop") : null, /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-size" }, /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-num" }, fmtTokens(item.tokens)), /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-mini", "aria-hidden": "true" }, /* @__PURE__ */ import_react6.default.createElement("i", { style: { width: Math.max(2, Math.round(item.tokens / (max || 1) * 100)) + "%", background: g.color } })))),
    expanded ? detail : null
  ));
}
async function undropItem(api, model, item, sessionId) {
  try {
    const r = await api.undrop(item.dropped.id);
    toast({ message: r.queued ? "It comes back when the next turn starts." : "Put back " + (r.restored || 1) + " " + plural(r.restored || 1, "item") + ".", sessionId });
  } catch (e) {
    toastError("Could not put it back.", e, sessionId);
  } finally {
    model.refresh().catch(() => {
    });
  }
}
async function togglePin(api, model, item, sessionId) {
  try {
    if (item.pinned) {
      const r = await api.unpin(item.messageId);
      const pin = r.pin || {};
      toast({ message: "Unpinned. " + fmtTokens(pin.tokens || 0) + " tokens leave the context at the next reset.", sessionId, undo: async () => {
        await api.pin(item.messageId, pin.note);
        model.refresh().catch(() => {
        });
        return "Pinned again.";
      } });
    } else {
      const r = await api.pin(item.messageId);
      toast({ message: "Pinned. " + fmtTokens(r.pin && r.pin.tokens || 0) + " tokens, kept across /new and /clear.", sessionId, undo: async () => {
        await api.unpin(item.messageId);
        model.refresh().catch(() => {
        });
        return "Unpinned.";
      } });
    }
  } catch (e) {
    toastError(item.pinned ? "Could not unpin." : "Could not pin.", e, sessionId);
  } finally {
    model.refresh().catch(() => {
    });
  }
}
async function dropOne(api, model, item, sessionId) {
  model.patch((v) => ({ ...v, items: v.items.map((i) => i.seq === item.seq ? { ...i, pendingDrop: true } : i) }));
  try {
    const result = await api.drop([item.seq]);
    const canUndo = Array.isArray(result.undoable) && result.undoable.length > 0 || result.queued > 0;
    toast({ message: dropMessage(result), sessionId, undo: canUndo ? () => undoDrop(api, model, result) : null });
  } catch (e) {
    toastError("Could not drop it.", e, sessionId);
  } finally {
    model.refresh().catch(() => {
    });
  }
}
var pinnable = (item) => Boolean(item.messageId) && !item.dropped && (item.category === "user" || item.category === "assistant");
function SimpleContext({ sessionId, view, api, model, filter, onFilter, busyAgent, onAdvanced }) {
  const items = view.items || [];
  const [expanded, setExpanded] = (0, import_react6.useState)(null);
  const list = (0, import_react6.useMemo)(() => sortItems(filter ? items.filter((i) => groupOf(i.category).id === filter) : items, "size").slice(0, SIMPLE), [items, filter]);
  if (!items.length) return /* @__PURE__ */ import_react6.default.createElement(Empty, { title: "Context is empty" }, "Send a message and what the model sees will be listed here, biggest first.");
  const filterGroup = filter ? GROUPS.find((g) => g.id === filter) : null;
  return /* @__PURE__ */ import_react6.default.createElement("div", null, /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-phead" }, /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-help" }, filterGroup ? filterGroup.label : "Biggest items"), filterGroup ? /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-link", onClick: () => onFilter(null) }, "Show every type") : null), /* @__PURE__ */ import_react6.default.createElement("ul", { className: "cdx-list plain", "aria-label": "Biggest context items" }, list.map((item) => {
    const g = groupOf(item.category);
    const blocker = dropBlocker(item);
    const open = expanded === item.seq;
    return /* @__PURE__ */ import_react6.default.createElement("li", { key: item.seq }, /* @__PURE__ */ import_react6.default.createElement(
      "div",
      {
        className: "cdx-row click" + (item.dropped || item.pendingDrop ? " gone" : "") + (open ? " open" : ""),
        tabIndex: 0,
        "data-seq": item.seq,
        "aria-expanded": open,
        onClick: () => setExpanded(open ? null : item.seq),
        onKeyDown: (e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setExpanded(open ? null : item.seq);
          }
        },
        style: { gridTemplateColumns: "minmax(0,1fr) auto" }
      },
      /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-main" }, /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-sw", style: { background: g.color }, "aria-hidden": "true" }), item.pinned ? /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-pinmark", title: "Pinned", "aria-label": "Pinned" }, Icon.pin(12)) : null, /* @__PURE__ */ import_react6.default.createElement("span", { title: item.label }, item.label || "(empty)")), /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react6.default.createElement("span", null, kindLabel(item) + (item.time ? " \xB7 " + fmtAgo(item.time) : "")), item.dropped ? /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-chip" }, "Dropped") : null, item.pendingDrop ? /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-chip warn", title: "Tool outputs dropped between turns leave the context when the next turn starts." }, "Leaves at next turn") : null)),
      /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-side" }, /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-num cdx-sizenum", title: fmtTokens(item.tokens) + " tokens" }, fmtTokens(item.tokens)), /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-acts" }, pinnable(item) ? /* @__PURE__ */ import_react6.default.createElement(
        IconButton,
        {
          label: item.pinned ? "Unpin" : "Pin to context",
          pressed: item.pinned,
          className: item.pinned ? "on" : "",
          onClick: () => togglePin(api, model, item, sessionId)
        },
        Icon.pin(13)
      ) : null), item.dropped && item.dropped.undoable ? /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: (e) => {
        e.stopPropagation();
        undropItem(api, model, item, sessionId);
      } }, "Undrop") : blocker ? /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-drop1", "aria-hidden": "true" }) : /* @__PURE__ */ import_react6.default.createElement(
        "button",
        {
          type: "button",
          className: "cdx-btn s g cdx-drop1",
          "data-drop-one": item.seq,
          disabled: busyAgent,
          title: busyAgent ? "The agent is working. Drop when it has finished." : "Remove from the model context (the chat keeps it)",
          onClick: (e) => {
            e.stopPropagation();
            dropOne(api, model, item, sessionId);
          }
        },
        "Drop"
      )),
      open ? /* @__PURE__ */ import_react6.default.createElement(ItemDetail, { item, api, model, sessionId, onPinToggle: (it) => togglePin(api, model, it, sessionId) }) : null
    ));
  })), /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-panelfoot" }, /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-link", "data-show-all": true, onClick: () => onAdvanced(false) }, "Show all " + items.length + " " + plural(items.length, "item")), /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-link", "data-select-several": true, onClick: () => onAdvanced(true) }, "Select several")));
}
function ContextPanel(props) {
  const [advanced, setAdvanced] = (0, import_react6.useState)(null);
  const undroppable = (props.view.items || []).some((i) => i.dropped && i.dropped.undoable);
  if (!advanced) return /* @__PURE__ */ import_react6.default.createElement(SimpleContext, { ...props, onAdvanced: (select) => setAdvanced({ select }) });
  return /* @__PURE__ */ import_react6.default.createElement(ContextSection, { ...props, focusSelect: advanced.select, undroppable, onSimple: () => setAdvanced(null) });
}
function ContextSection({ sessionId, view, api, model, filter, onFilter, busyAgent, onSimple, focusSelect, undroppable }) {
  const items = view.items || [];
  const [selected, setSelected] = (0, import_react6.useState)(() => /* @__PURE__ */ new Set());
  const [sort, setSort] = (0, import_react6.useState)("size");
  const [query, setQuery] = (0, import_react6.useState)("");
  const [expanded, setExpanded] = (0, import_react6.useState)(null);
  const [showAll, setShowAll] = (0, import_react6.useState)(false);
  const [focusSeq, setFocusSeq] = (0, import_react6.useState)(null);
  const [anchor, setAnchor] = (0, import_react6.useState)(null);
  const [dropping, setDropping] = (0, import_react6.useState)(false);
  const rowRefs = (0, import_react6.useRef)(/* @__PURE__ */ new Map());
  (0, import_react6.useEffect)(() => {
    const live = new Set(items.map((i) => i.seq));
    setSelected((prev) => {
      let changed = false;
      const next = /* @__PURE__ */ new Set();
      for (const s of prev) {
        if (live.has(s) && !dropBlocker(items.find((i) => i.seq === s))) next.add(s);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [view.fingerprint]);
  const filtered = (0, import_react6.useMemo)(() => {
    let list = items;
    if (filter) list = list.filter((i) => groupOf(i.category).id === filter);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((i) => (i.label || "").toLowerCase().includes(q) || (i.tool || "").toLowerCase().includes(q) || (i.preview || "").toLowerCase().includes(q));
    return sortItems(list, sort);
  }, [items, filter, query, sort]);
  const visible = showAll ? filtered : filtered.slice(0, PAGE);
  const max = (0, import_react6.useMemo)(() => items.reduce((m, i) => Math.max(m, i.tokens || 0), 0), [items]);
  const total = (0, import_react6.useMemo)(() => selectionTotal(items, selected), [items, selected]);
  const editedSeqs = (0, import_react6.useMemo)(() => new Set((view.versions || []).map((v) => v.replacementSeq).filter((x) => Number.isFinite(x))), [view.versions]);
  const tickableVisible = visible.filter((i) => !dropBlocker(i));
  const allTicked = tickableVisible.length > 0 && tickableVisible.every((i) => selected.has(i.seq));
  const someTicked = tickableVisible.some((i) => selected.has(i.seq));
  const focusedSeq = focusSeq !== null && visible.some((i) => i.seq === focusSeq) ? focusSeq : visible[0] && visible[0].seq;
  const toggle = (seq2, on) => setSelected((prev) => {
    const next = new Set(prev);
    const want = on === void 0 ? !next.has(seq2) : on;
    if (want) next.add(seq2);
    else next.delete(seq2);
    return next;
  });
  const selectAll = (on) => setSelected(on ? new Set(tickableVisible.map((i) => i.seq)) : /* @__PURE__ */ new Set());
  const focusRow = (seq2) => {
    setFocusSeq(seq2);
    const el = rowRefs.current.get(seq2);
    if (el) el.focus();
  };
  const drop = async () => {
    if (!total.count || dropping) return;
    if (busyAgent) {
      toast({ tone: "error", message: "The agent is working. Drop again when it has finished.", sessionId });
      return;
    }
    setDropping(true);
    const seqs = total.seqs;
    model.patch((v) => ({ ...v, items: v.items.map((i) => total.expanded.includes(i.seq) ? { ...i, pendingDrop: true } : i) }));
    try {
      const result = await api.drop(seqs);
      setSelected(/* @__PURE__ */ new Set());
      setExpanded(null);
      const canUndo = Array.isArray(result.undoable) && result.undoable.length > 0 || result.queued > 0;
      toast({ message: dropMessage(result), sessionId, undo: canUndo ? () => undoDrop(api, model, result) : null });
    } catch (e) {
      toastError("Could not drop the items.", e, sessionId);
    } finally {
      setDropping(false);
      model.refresh().catch(() => {
      });
    }
  };
  const undropOne = (item) => undropItem(api, model, item, sessionId);
  const pinToggle = (item) => togglePin(api, model, item, sessionId);
  const onKeyDown = (e) => {
    if (e.target.closest && e.target.closest("input,textarea,select,[contenteditable=true]") && e.target.type !== "checkbox") return;
    const idx = visible.findIndex((i) => i.seq === focusedSeq);
    if (idx < 0) return;
    const item = visible[idx];
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (key === "ArrowDown" || key === "ArrowUp") {
      e.preventDefault();
      const next = visible[Math.max(0, Math.min(visible.length - 1, idx + (key === "ArrowDown" ? 1 : -1)))];
      if (e.shiftKey) {
        const from = anchor === null ? item.seq : anchor;
        if (anchor === null) setAnchor(item.seq);
        const a = visible.findIndex((i) => i.seq === from);
        const b = visible.findIndex((i) => i.seq === next.seq);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected((prev) => {
          const s = new Set(prev);
          for (let k = lo; k <= hi; k += 1) if (!dropBlocker(visible[k])) s.add(visible[k].seq);
          return s;
        });
      } else setAnchor(null);
      focusRow(next.seq);
    } else if (key === "Home" || key === "End") {
      e.preventDefault();
      focusRow((key === "Home" ? visible[0] : visible[visible.length - 1]).seq);
    } else if ((key === "x" || key === "X" || key === " ") && !mod) {
      e.preventDefault();
      if (!dropBlocker(item)) toggle(item.seq);
    } else if (key === "Enter") {
      e.preventDefault();
      setExpanded(expanded === item.seq ? null : item.seq);
    } else if (key === "Delete" || key === "Backspace") {
      if (total.count) {
        e.preventDefault();
        drop();
      }
    } else if (mod && (key === "a" || key === "A")) {
      e.preventDefault();
      selectAll(true);
    } else if (key === "Escape") {
      if (expanded !== null || selected.size) {
        e.preventDefault();
        e.stopPropagation();
        setExpanded(null);
        setSelected(/* @__PURE__ */ new Set());
      }
    }
  };
  if (!items.length) {
    return /* @__PURE__ */ import_react6.default.createElement(Empty, { title: "Context is empty" }, "Send a message and every item the model sees will be listed here with its size.");
  }
  const filterGroup = filter ? GROUPS.find((g) => g.id === filter) : null;
  return /* @__PURE__ */ import_react6.default.createElement("div", { onKeyDown }, /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-tools" }, /* @__PURE__ */ import_react6.default.createElement("label", { title: allTicked ? "Clear selection" : "Select every droppable item shown" }, /* @__PURE__ */ import_react6.default.createElement(
    "input",
    {
      type: "checkbox",
      autoFocus: Boolean(focusSelect),
      checked: allTicked,
      ref: (el) => {
        if (el) el.indeterminate = !allTicked && someTicked;
      },
      disabled: !tickableVisible.length,
      onChange: () => selectAll(!allTicked),
      style: { accentColor: "var(--clay)", margin: 0 }
    }
  ), "All"), /* @__PURE__ */ import_react6.default.createElement("select", { className: "cdx-in s", value: sort, onChange: (e) => setSort(e.target.value), "aria-label": "Sort items" }, /* @__PURE__ */ import_react6.default.createElement("option", { value: "size" }, "Largest first"), /* @__PURE__ */ import_react6.default.createElement("option", { value: "newest" }, "Newest first"), /* @__PURE__ */ import_react6.default.createElement("option", { value: "age" }, "Oldest first"), /* @__PURE__ */ import_react6.default.createElement("option", { value: "type" }, "By type")), filterGroup ? /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-chipbtn", "aria-pressed": "true", onClick: () => onFilter(null), "aria-label": "Remove filter " + filterGroup.label }, /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-sw", style: { background: filterGroup.color } }), filterGroup.label, Icon.close(10)) : null, items.length >= 25 ? /* @__PURE__ */ import_react6.default.createElement(
    "input",
    {
      className: "cdx-in s",
      style: { flex: "1 1 90px", width: "auto", minWidth: 80 },
      type: "search",
      placeholder: "Search items",
      "aria-label": "Search context items",
      value: query,
      onChange: (e) => setQuery(e.target.value)
    }
  ) : /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-spacer" }), filter || query.trim() ? /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-help cdx-num", "aria-live": "polite" }, filtered.length + " of " + items.length) : null, onSimple ? /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-link", "data-simple-view": true, onClick: onSimple }, "Fewer") : null), undroppable ? /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-phead" }, /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-spacer" }), /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-link", onClick: async () => {
    try {
      const r = await api.undrop("all");
      toast({ message: r.text || "Put back every dropped item.", sessionId });
    } catch (e) {
      toastError("Could not put the items back.", e, sessionId);
    } finally {
      model.refresh().catch(() => {
      });
    }
  } }, "Undrop all")) : null, filtered.length === 0 ? /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-empty" }, "No items match. ", /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-link", onClick: () => {
    setQuery("");
    onFilter(null);
  } }, "Show every item")) : null, /* @__PURE__ */ import_react6.default.createElement("ul", { className: "cdx-list", "aria-label": "Context items" }, visible.map((item) => /* @__PURE__ */ import_react6.default.createElement(
    ItemRow,
    {
      key: item.seq,
      item,
      max,
      ticked: selected.has(item.seq),
      focused: item.seq === focusedSeq,
      expanded: expanded === item.seq,
      edited: editedSeqs.has(item.seq),
      rowRef: (el) => {
        if (el) rowRefs.current.set(item.seq, el);
        else rowRefs.current.delete(item.seq);
      },
      onFocusRow: () => setFocusSeq(item.seq),
      onTick: () => toggle(item.seq),
      onToggle: () => {
        setFocusSeq(item.seq);
        setExpanded(expanded === item.seq ? null : item.seq);
      },
      onUndrop: undropOne,
      detail: expanded === item.seq ? /* @__PURE__ */ import_react6.default.createElement(ItemDetail, { item, api, model, sessionId, onPinToggle: pinToggle }) : null
    }
  ))), !showAll && filtered.length > PAGE ? /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-more" }, /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-btn s", onClick: () => setShowAll(true) }, "Show all " + filtered.length)) : null, total.count > 0 ? /* @__PURE__ */ import_react6.default.createElement("div", { className: "cdx-foot", "data-drop-footer": true }, /* @__PURE__ */ import_react6.default.createElement("span", { className: "cdx-grow cdx-num", "aria-live": "polite" }, total.count + " selected, " + fmtTokens(total.tokens)), /* @__PURE__ */ import_react6.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => setSelected(/* @__PURE__ */ new Set()) }, "Clear selection"), /* @__PURE__ */ import_react6.default.createElement(
    "button",
    {
      type: "button",
      className: "cdx-btn s d",
      "data-drop": true,
      disabled: dropping,
      onClick: drop,
      title: "Remove the ticked items from the model context. The chat keeps them, and originals are saved."
    },
    "Drop " + total.count + " " + plural(total.count, "item") + " (" + fmtTokens(total.tokens) + ")"
  )) : null);
}

// src/client/sections/pins.jsx
var import_react7 = __toESM(require("react"), 1);
var PIN_LIMIT = 50;
async function unpinWithUndo(api, model, pin, sessionId) {
  await api.unpin(pin.id);
  toast({
    message: "Unpinned. " + fmtTokens(pin.tokens || 0) + " tokens leave the context at the next reset.",
    sessionId,
    undo: async () => {
      await api.pin(pin.messageId, pin.note);
      model.refresh().catch(() => {
      });
      return "Pinned again. " + fmtTokens(pin.tokens || 0) + " tokens.";
    }
  });
  model.refresh().catch(() => {
  });
}
function PinRow({ pin, api, model, sessionId }) {
  const [open, setOpen] = (0, import_react7.useState)(false);
  const [note, setNote] = (0, import_react7.useState)(null);
  const [busy, setBusy] = (0, import_react7.useState)(false);
  const saveNote = async () => {
    setBusy(true);
    try {
      await api.pinNote(pin.id, note.trim());
      toast({ message: note.trim() ? "Note saved." : "Note removed.", sessionId });
      setNote(null);
    } catch (e) {
      toastError("Could not save the note.", e, sessionId);
    } finally {
      setBusy(false);
      model.refresh().catch(() => {
      });
    }
  };
  return /* @__PURE__ */ import_react7.default.createElement("li", null, /* @__PURE__ */ import_react7.default.createElement(
    "div",
    {
      className: "cdx-row click" + (open ? " open" : ""),
      tabIndex: 0,
      "data-pin": pin.id,
      "aria-expanded": open,
      onClick: () => setOpen(!open),
      onKeyDown: (e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          setOpen(!open);
        }
      }
    },
    /* @__PURE__ */ import_react7.default.createElement("span", { style: { color: "var(--clay)", display: "inline-flex" }, "aria-hidden": "true" }, Icon.pin(13)),
    /* @__PURE__ */ import_react7.default.createElement("div", { className: "cdx-main" }, /* @__PURE__ */ import_react7.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react7.default.createElement("span", { className: "cdx-clamp", style: { whiteSpace: "normal" } }, excerpt(pin.text, 140))), /* @__PURE__ */ import_react7.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react7.default.createElement("span", { className: "cdx-chip" }, pin.role === "user" ? "You" : "Assistant"), /* @__PURE__ */ import_react7.default.createElement("span", null, (pin.by === "model" ? "pinned by the assistant" : "pinned") + " " + fmtAgo(pin.at)), pin.note ? /* @__PURE__ */ import_react7.default.createElement("span", { title: pin.note }, "\xB7 " + pin.note) : null)),
    /* @__PURE__ */ import_react7.default.createElement("div", { className: "cdx-side" }, /* @__PURE__ */ import_react7.default.createElement("span", { className: "cdx-acts" }, /* @__PURE__ */ import_react7.default.createElement(IconButton, { label: "Copy pinned text", onClick: async () => {
      const ok = await copyText(pin.text);
      toast({ message: ok ? "Copied the pinned text." : "Copy is not available in this browser.", sessionId });
    } }, Icon.copy(13)), /* @__PURE__ */ import_react7.default.createElement(IconButton, { label: "Edit note", onClick: () => {
      setOpen(true);
      setNote(pin.note || "");
    } }, Icon.note(13)), /* @__PURE__ */ import_react7.default.createElement(IconButton, { label: "Unpin", onClick: () => unpinWithUndo(api, model, pin, sessionId).catch((e) => toastError("Could not unpin.", e, sessionId)) }, Icon.close(12))), /* @__PURE__ */ import_react7.default.createElement("span", { className: "cdx-num", title: "Tokens this pin adds to every context" }, fmtTokens(pin.tokens || 0))),
    open ? /* @__PURE__ */ import_react7.default.createElement("div", { className: "cdx-detail", onClick: (e) => e.stopPropagation(), onKeyDown: (e) => e.stopPropagation() }, note !== null ? /* @__PURE__ */ import_react7.default.createElement(import_react7.default.Fragment, null, /* @__PURE__ */ import_react7.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react7.default.createElement("span", null, "Note (shown with the pin, up to 300 characters)"), /* @__PURE__ */ import_react7.default.createElement(
      "input",
      {
        className: "cdx-in",
        maxLength: 300,
        value: note,
        autoFocus: true,
        onChange: (e) => setNote(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter") saveNote();
          if (e.key === "Escape") setNote(null);
        }
      }
    )), /* @__PURE__ */ import_react7.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react7.default.createElement("button", { type: "button", className: "cdx-btn p s", disabled: busy, onClick: saveNote }, "Save note"), /* @__PURE__ */ import_react7.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => setNote(null) }, "Cancel"))) : /* @__PURE__ */ import_react7.default.createElement("div", { className: "cdx-text" }, pin.text)) : null
  ));
}
function PinsSection({ sessionId, view, api, model }) {
  const pins = [...view.pins || []].reverse();
  if (!pins.length) {
    return /* @__PURE__ */ import_react7.default.createElement(Empty, { title: "No pinned messages" }, "Click the star on a message, or type /pin, to keep it in context across /new and /clear.");
  }
  const full = pins.length >= PIN_LIMIT;
  const tokens = pins.reduce((s, p) => s + (p.tokens || 0), 0);
  return /* @__PURE__ */ import_react7.default.createElement("div", null, /* @__PURE__ */ import_react7.default.createElement("div", { className: "cdx-phead" }, /* @__PURE__ */ import_react7.default.createElement("span", { className: "cdx-help", style: full ? { color: "var(--warn)" } : void 0 }, full ? "Pin limit reached. Unpin one to add another." : pins.length + " " + (pins.length === 1 ? "pin" : "pins") + ", " + fmtTokens(tokens) + " tokens, kept across every reset")), /* @__PURE__ */ import_react7.default.createElement("ul", { className: "cdx-list plain", "aria-label": "Pinned messages" }, pins.map((p) => /* @__PURE__ */ import_react7.default.createElement(PinRow, { key: p.id, pin: p, api, model, sessionId }))));
}

// src/client/sections/inbox.jsx
var import_react8 = __toESM(require("react"), 1);
var hiddenInbox = createSignal(/* @__PURE__ */ new Set());
function hide(ids, on) {
  const next = new Set(hiddenInbox.get());
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  hiddenInbox.set(next);
}
async function dismissWithUndo(api, model, ids, sessionId) {
  if (!ids.length) return;
  hide(ids, true);
  try {
    await api.inbox("dismiss", ids);
    toast({
      message: "Dismissed " + ids.length + " " + plural(ids.length, "message") + ".",
      sessionId,
      undo: async () => {
        await api.inbox("undismiss", ids);
        await model.refresh().catch(() => {
        });
        hide(ids, false);
        return "Restored " + ids.length + " " + plural(ids.length, "message") + " to the inbox.";
      }
    });
    await model.refresh().catch(() => {
    });
  } catch (e) {
    toastError("Could not dismiss.", e, sessionId);
  } finally {
    hide(ids, false);
  }
}
async function markAllRead(api, model, view, sessionId) {
  const ids = (view.inbox || []).filter((e) => !e.read).map((e) => e.id);
  if (!ids.length) return;
  try {
    await api.inbox("read", ids);
    toast({
      message: "Marked " + ids.length + " " + plural(ids.length, "message") + " read.",
      sessionId,
      undo: async () => {
        await api.inbox("unread", ids);
        model.refresh().catch(() => {
        });
        return "Marked " + ids.length + " unread again.";
      }
    });
  } catch (e) {
    toastError("Could not mark the messages read.", e, sessionId);
  } finally {
    model.refresh().catch(() => {
    });
  }
}
function deliveredLabel(entry) {
  if (entry.visible === "user") return "Visible to you only";
  if (entry.delivered === "appended") return "In the model context";
  if (entry.delivered === "next-step") return "Given to the model at its next step";
  if (typeof entry.delivered === "string" && entry.delivered.startsWith("failed")) return "Not delivered to the model";
  return "";
}
function InboxRow({ entry, open, focused, onToggle, onFocusRow, rowRef, api, model, sessionId, openSession, openFile }) {
  const add = async () => {
    try {
      const r = await api.inbox("add", [entry.id]);
      toast({ message: r.delivered === "next-step" ? "Added. The model sees it at its next step." : "Added to the model context.", sessionId });
    } catch (e) {
      toastError("Could not add it to the context.", e, sessionId);
    } finally {
      model.refresh().catch(() => {
      });
    }
  };
  const markUnread = async () => {
    try {
      await api.inbox("unread", [entry.id]);
      onToggle(false);
    } catch (e) {
      toastError("Could not mark it unread.", e, sessionId);
    } finally {
      model.refresh().catch(() => {
      });
    }
  };
  const label = deliveredLabel(entry);
  return /* @__PURE__ */ import_react8.default.createElement("li", null, /* @__PURE__ */ import_react8.default.createElement(
    "div",
    {
      className: "cdx-row click" + (entry.read ? " muted" : " unread") + (open ? " open" : ""),
      ref: rowRef,
      tabIndex: focused ? 0 : -1,
      "data-inbox": entry.id,
      "aria-expanded": open,
      onClick: () => onToggle(),
      onFocus: onFocusRow
    },
    /* @__PURE__ */ import_react8.default.createElement(
      "span",
      {
        className: "cdx-dot" + (entry.read ? "" : " live"),
        style: entry.read ? { background: "transparent" } : void 0,
        "aria-label": entry.read ? void 0 : "Unread",
        role: entry.read ? void 0 : "img"
      }
    ),
    /* @__PURE__ */ import_react8.default.createElement("div", { className: "cdx-main" }, /* @__PURE__ */ import_react8.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react8.default.createElement("span", null, firstLine(entry.text, 120) || "(empty message)")), /* @__PURE__ */ import_react8.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react8.default.createElement("span", { className: "cdx-chip", title: entry.from && entry.from.sessionId ? entry.from.sessionId : void 0 }, entry.from && entry.from.label || "unknown"), entry.kind && entry.kind !== "note" ? /* @__PURE__ */ import_react8.default.createElement("span", { className: "cdx-chip" + (entry.kind === "alert" ? " bad" : "") }, entry.kind) : null, /* @__PURE__ */ import_react8.default.createElement("span", null, fmtAgo(entry.at)))),
    /* @__PURE__ */ import_react8.default.createElement("div", { className: "cdx-side" }, /* @__PURE__ */ import_react8.default.createElement("span", { className: "cdx-acts" }, entry.from && entry.from.sessionId ? /* @__PURE__ */ import_react8.default.createElement(IconButton, { label: "Open source chat", onClick: () => openSession(entry.from.sessionId) }, Icon.open(13)) : null, /* @__PURE__ */ import_react8.default.createElement(IconButton, { label: "Dismiss", onClick: () => dismissWithUndo(api, model, [entry.id], sessionId) }, Icon.close(12)))),
    open ? /* @__PURE__ */ import_react8.default.createElement("div", { className: "cdx-detail", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ import_react8.default.createElement("div", { className: "cdx-text" }, entry.text), label ? /* @__PURE__ */ import_react8.default.createElement("span", { className: "cdx-help" }, label) : null, /* @__PURE__ */ import_react8.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react8.default.createElement("button", { type: "button", className: "cdx-btn s", onClick: add, title: "Give this message to the model again" }, Icon.inject(13), "Add to context"), entry.from && entry.from.sessionId ? /* @__PURE__ */ import_react8.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => openSession(entry.from.sessionId) }, Icon.open(13), "Open source chat") : null, entry.file ? /* @__PURE__ */ import_react8.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => openFile(entry.file) }, "Full text") : null, /* @__PURE__ */ import_react8.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: markUnread }, "Mark unread"), /* @__PURE__ */ import_react8.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => dismissWithUndo(api, model, [entry.id], sessionId) }, "Dismiss"))) : null
  ));
}
function InboxSection({ sessionId, view, api, model, openSession, openFile }) {
  const hidden = useSignal(hiddenInbox);
  const entries = (view.inbox || []).filter((e) => !hidden.has(e.id)).map((e, i) => [e, i]).sort((a, b) => a[0].read === b[0].read ? a[1] - b[1] : a[0].read ? 1 : -1).map((x) => x[0]);
  const [open, setOpen] = (0, import_react8.useState)(null);
  const [focusId, setFocusId] = (0, import_react8.useState)(null);
  const refs = (0, import_react8.useRef)(/* @__PURE__ */ new Map());
  const [posting, setPosting] = (0, import_react8.useState)(false);
  const focused = focusId && entries.some((e) => e.id === focusId) ? focusId : entries[0] && entries[0].id;
  const toggle = (entry, force) => {
    const willOpen = force === void 0 ? open !== entry.id : force;
    setOpen(willOpen ? entry.id : null);
    setFocusId(entry.id);
    if (willOpen && !entry.read) {
      model.patch((v) => ({ ...v, unread: Math.max(0, (v.unread || 0) - 1), inbox: v.inbox.map((x) => x.id === entry.id ? { ...x, read: true } : x) }));
      api.inbox("read", [entry.id]).catch(() => {
      }).finally(() => model.refresh().catch(() => {
      }));
    }
  };
  const move = (delta) => {
    const i = entries.findIndex((e) => e.id === focused);
    const next = entries[Math.max(0, Math.min(entries.length - 1, i + delta))];
    if (next) {
      setFocusId(next.id);
      const el = refs.current.get(next.id);
      if (el) el.focus();
    }
  };
  const onKeyDown = (e) => {
    if (e.target.closest && e.target.closest("input,textarea,select")) return;
    const entry = entries.find((x) => x.id === focused);
    if (!entry) return;
    if (e.key === "ArrowDown" || e.key === "j" || e.key === "J") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp" || e.key === "k" || e.key === "K") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(-1e6);
    } else if (e.key === "End") {
      e.preventDefault();
      move(1e6);
    } else if (e.key === "Enter") {
      e.preventDefault();
      toggle(entry);
    } else if ((e.key === "e" || e.key === "E") && !e.shiftKey) {
      e.preventDefault();
      move(1);
      dismissWithUndo(api, model, [entry.id], sessionId);
    } else if (e.key === "I" && e.shiftKey) {
      e.preventDefault();
      markAllRead(api, model, view, sessionId);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(null);
    }
  };
  const readIds = entries.filter((e) => e.read).map((e) => e.id);
  const unread = entries.filter((e) => !e.read).length;
  return /* @__PURE__ */ import_react8.default.createElement("div", { onKeyDown }, entries.length ? /* @__PURE__ */ import_react8.default.createElement("div", { className: "cdx-phead" }, /* @__PURE__ */ import_react8.default.createElement("span", { className: "cdx-help" }, unread ? unread + " unread" : "All read"), /* @__PURE__ */ import_react8.default.createElement("span", { className: "cdx-spacer" }), unread ? /* @__PURE__ */ import_react8.default.createElement("button", { type: "button", className: "cdx-link", "data-mark-all-read": true, onClick: () => markAllRead(api, model, view, sessionId) }, "Mark all read") : null) : null, entries.length === 0 ? /* @__PURE__ */ import_react8.default.createElement(Empty, { title: "Inbox is empty" }, "Messages from other chats and scripts that did not wake the agent will appear here.") : /* @__PURE__ */ import_react8.default.createElement("ul", { className: "cdx-list plain", "aria-label": "Inbox messages" }, entries.map((entry) => /* @__PURE__ */ import_react8.default.createElement(
    InboxRow,
    {
      key: entry.id,
      entry,
      open: open === entry.id,
      focused: entry.id === focused,
      rowRef: (el) => {
        if (el) refs.current.set(entry.id, el);
        else refs.current.delete(entry.id);
      },
      onFocusRow: () => setFocusId(entry.id),
      onToggle: (force) => toggle(entry, force),
      api,
      model,
      sessionId,
      openSession,
      openFile
    }
  ))), /* @__PURE__ */ import_react8.default.createElement("div", { className: "cdx-panelfoot" }, /* @__PURE__ */ import_react8.default.createElement("button", { type: "button", className: "cdx-btn s g", "aria-expanded": posting, "data-post-toggle": true, onClick: () => setPosting(!posting) }, Icon.send(13), "Post to another chat"), /* @__PURE__ */ import_react8.default.createElement("span", { className: "cdx-spacer" }), readIds.length ? /* @__PURE__ */ import_react8.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => dismissWithUndo(api, model, readIds, sessionId) }, "Clear read") : null), posting ? /* @__PURE__ */ import_react8.default.createElement(PostForm, { sessionId, onDone: () => setPosting(false) }) : null);
}
function PostForm({ sessionId, onDone, initialTarget }) {
  const status = useSignal(statusModel);
  const [to, setTo] = (0, import_react8.useState)(initialTarget || "");
  const [text, setText] = (0, import_react8.useState)("");
  const [kind, setKind] = (0, import_react8.useState)("note");
  const [visible, setVisible] = (0, import_react8.useState)("user+model");
  const [busy, setBusy] = (0, import_react8.useState)(false);
  const [error, setError] = (0, import_react8.useState)("");
  (0, import_react8.useEffect)(() => {
    if (!status.data) refreshStatus();
  }, []);
  const rows = (0, import_react8.useMemo)(() => (status.data && status.data.agents && status.data.agents.rows || []).filter((r) => r.sessionId !== sessionId), [status.data, sessionId]);
  const target = rows.find((r) => r.sessionId === to);
  const submit = async (e) => {
    e.preventDefault();
    if (!to || !text.trim()) return;
    setBusy(true);
    setError("");
    try {
      await postToChat({ to, text: text.trim(), kind, visible, fromSessionId: sessionId });
      toast({ message: "Posted silently to " + (target && target.title || shortId(to)) + ". It did not wake that chat.", sessionId });
      setText("");
      if (onDone) onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ import_react8.default.createElement("form", { className: "cdx-form", onSubmit: submit, "aria-label": "Post a silent message to another chat", "data-post-form": true }, /* @__PURE__ */ import_react8.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react8.default.createElement("span", null, "To"), /* @__PURE__ */ import_react8.default.createElement("select", { className: "cdx-in", style: { width: "100%" }, value: to, onChange: (e) => setTo(e.target.value), required: true }, /* @__PURE__ */ import_react8.default.createElement("option", { value: "" }, rows.length ? "Choose a chat" : "Loading chats\u2026"), rows.map((r) => /* @__PURE__ */ import_react8.default.createElement("option", { key: r.sessionId, value: r.sessionId }, (r.title || "(untitled)") + (r.running ? " (working)" : "") + " \xB7 " + shortId(r.sessionId))))), /* @__PURE__ */ import_react8.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react8.default.createElement("span", null, "Message"), /* @__PURE__ */ import_react8.default.createElement(
    "textarea",
    {
      className: "cdx-in",
      rows: 3,
      value: text,
      onChange: (e) => setText(e.target.value),
      placeholder: "What the other chat should know",
      onKeyDown: (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(e);
      },
      required: true
    }
  )), /* @__PURE__ */ import_react8.default.createElement("div", { className: "cdx-frow" }, /* @__PURE__ */ import_react8.default.createElement("div", { className: "cdx-radio", role: "radiogroup", "aria-label": "Who sees it" }, /* @__PURE__ */ import_react8.default.createElement("label", null, /* @__PURE__ */ import_react8.default.createElement("input", { type: "radio", name: "cdx-vis-" + sessionId, checked: visible === "user+model", onChange: () => setVisible("user+model") }), /* @__PURE__ */ import_react8.default.createElement("span", null, "The chat and its model", /* @__PURE__ */ import_react8.default.createElement("span", { className: "cdx-help", style: { display: "block" } }, "The model reads it on its next turn; the chat is not woken."))), /* @__PURE__ */ import_react8.default.createElement("label", null, /* @__PURE__ */ import_react8.default.createElement("input", { type: "radio", name: "cdx-vis-" + sessionId, checked: visible === "user", onChange: () => setVisible("user") }), /* @__PURE__ */ import_react8.default.createElement("span", null, "Only the person reading that chat"))), /* @__PURE__ */ import_react8.default.createElement("label", { className: "cdx-field", style: { flex: "0 0 auto" } }, /* @__PURE__ */ import_react8.default.createElement("span", null, "Kind"), /* @__PURE__ */ import_react8.default.createElement("select", { className: "cdx-in", value: kind, onChange: (e) => setKind(e.target.value) }, /* @__PURE__ */ import_react8.default.createElement("option", { value: "note" }, "Note"), /* @__PURE__ */ import_react8.default.createElement("option", { value: "report" }, "Report"), /* @__PURE__ */ import_react8.default.createElement("option", { value: "alert" }, "Alert")))), error ? /* @__PURE__ */ import_react8.default.createElement(Note, { tone: "bad", role: "alert" }, error) : null, /* @__PURE__ */ import_react8.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react8.default.createElement("button", { type: "submit", className: "cdx-btn p s", disabled: busy || !to || !text.trim() }, busy ? "Posting\u2026" : "Post silently"), onDone ? /* @__PURE__ */ import_react8.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: onDone }, "Cancel") : null));
}

// src/client/sections/history.jsx
var import_react11 = __toESM(require("react"), 1);

// src/client/chat.jsx
var import_react9 = __toESM(require("react"), 1);
var GHOST_KIND = "conductor-ghost";
var GHOST_SOURCE = "dsh-conductor-post";
var REWIND_KIND = "conductor-rewind";
var REWIND_SOURCE = "dsh-conductor-rewind";
var NODE_SLOT = "conversation.chat.node";
var SHADOW_PRIORITY = -100;
var SIMULATE_KEY = "dsh-conductor:simulate-no-chat-shadow";
var FALLBACK_NOTICE = "This DSH version does not let Conductor show edited text in the chat; the model still sees the new text. Versions are listed here.";
var SHADOW_KEYS = { user: "user", assistant: "assistant-step" };
var SHADOW_GRACE_MS = 15e3;
var shadowHealth = createSignal({ state: "unverified", reason: "", registered: {}, rendered: {}, since: 0 });
function setHealth(patch) {
  const cur = shadowHealth.get();
  const next = { ...cur, ...patch, registered: { ...cur.registered, ...patch.registered || {} }, rendered: { ...cur.rendered, ...patch.rendered || {} } };
  if (cur.state === "unavailable" && next.state !== "unavailable") next.state = "unavailable";
  if (JSON.stringify(next) !== JSON.stringify(cur)) shadowHealth.set(next);
}
function markUnavailable(reason) {
  setHealth({ state: "unavailable", reason });
}
function simulated() {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(SIMULATE_KEY) === "1";
  } catch {
    return false;
  }
}
function useRenderedMark(key, edited) {
  (0, import_react9.useEffect)(() => {
    const cur = shadowHealth.get();
    if (!cur.rendered[key]) setHealth({ rendered: { [key]: true } });
    if (edited && cur.state === "unverified") setHealth({ state: "active", reason: "" });
  }, [key, edited]);
}
var warned = /* @__PURE__ */ new Set();
function editFallbackReason(view, health = shadowHealth.get(), now = Date.now()) {
  if (!view || !moduleOn("versions")) return null;
  const edited = (view.versions || []).filter((e) => (e.versions || []).length > 1);
  if (!edited.length) return null;
  let reason = null;
  if (health.state === "active") return null;
  if (health.state === "unavailable") reason = health.reason || "the chat renderers could not be extended";
  else {
    for (const e of edited) {
      const key = SHADOW_KEYS[e.role === "user" ? "user" : "assistant"];
      if (health.registered[key] && !health.rendered[key] && health.since && now - health.since > SHADOW_GRACE_MS) {
        reason = 'the chat no longer renders messages through the "' + key + '" renderer Conductor extends';
        break;
      }
    }
  }
  if (reason && !warned.has(reason)) {
    warned.add(reason);
    console.warn("[dsh-conductor] edited messages show their original text in the chat: " + reason + ". The model still sees the edited text; versions are listed in Conductor, History.");
  }
  return reason;
}
function useEditFallback(view) {
  const health = useSignal(shadowHealth);
  const [, tick] = (0, import_react9.useState)(0);
  (0, import_react9.useEffect)(() => {
    if (health.state !== "unverified" || !health.since) return void 0;
    const left = SHADOW_GRACE_MS - (Date.now() - health.since) + 50;
    if (left <= 0) return void 0;
    const t = setTimeout(() => tick((n) => n + 1), left);
    return () => clearTimeout(t);
  }, [health]);
  return editFallbackReason(view, health);
}
var textOf = (content) => Array.isArray(content) ? content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n") : "";
var GHOST_HEADER = /^\[Silent message from (.+?)(?:, (report|alert|note))?, (\d{4}-\d\d-\d\dT[0-9:.]+Z?)\. It did not wake you; take it into account when relevant\.\]\s*\n?/;
function parseGhost(text) {
  const raw = String(text || "");
  const m = raw.match(GHOST_HEADER);
  if (!m) return { from: "", kind: "note", at: "", body: raw };
  return { from: m[1], kind: m[2] || "note", at: m[3], body: raw.slice(m[0].length) };
}
var ghostDefinition = {
  kind: GHOST_KIND,
  target: "chat",
  match: (event) => {
    if (!event || event.type !== "user/message" || event.surfaceOp !== "append") return null;
    const source = event.data && event.data.source;
    if (!source || source.kind !== GHOST_SOURCE) return null;
    return { id: String(event.data.id), role: "start", exclusive: true };
  },
  start: (_context, match) => {
    const event = match.event;
    const parsed = parseGhost(textOf(event.data.content));
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      summary: event.data.source.summary || "",
      ...parsed
    };
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === void 0) return null;
    return {
      key: context.key,
      kind: GHOST_KIND,
      id: context.id,
      target: "chat",
      anchorSeq: context.state.seq,
      location: context.start && context.start.location || { kind: "unresolved" },
      visibility: "visible",
      groupTree: "input",
      data: context.state
    };
  }
};
function rewindLabel(data) {
  const summary = data && data.source && data.source.summary;
  if (typeof summary === "string" && summary.startsWith("Rewound to: ")) return summary.slice(12);
  const m = textOf(data && data.content).match(/checkpoint before "([^"]*)"/);
  return m ? m[1] : "";
}
var rewindDefinition = {
  kind: REWIND_KIND,
  target: "chat",
  match: (event) => {
    if (!event || event.type !== "user/message") return null;
    const source = event.data && event.data.source;
    if (!source || source.kind !== REWIND_SOURCE) return null;
    return { id: String(event.data.id), role: "start", exclusive: true };
  },
  start: (_context, match) => ({ seq: match.event.seq, time: match.event.time, label: rewindLabel(match.event.data) }),
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === void 0) return null;
    return {
      key: context.key,
      kind: REWIND_KIND,
      id: context.id,
      target: "chat",
      anchorSeq: context.state.seq,
      location: context.start && context.start.location || { kind: "unresolved" },
      visibility: "visible",
      groupTree: "input",
      data: context.state
    };
  }
};
function RewindDivider({ node, sessionId, openSection: openSection2 }) {
  (0, import_react9.useEffect)(() => {
    ensureStyles();
  }, []);
  const data = node && node.data || {};
  return /* @__PURE__ */ import_react9.default.createElement("div", { className: "cdx-rewound", role: "separator", "aria-label": "Rewound to before " + (data.label || "a checkpoint"), "data-conductor-rewind": true }, /* @__PURE__ */ import_react9.default.createElement("span", { className: "cdx-rewound-line", "aria-hidden": "true" }), /* @__PURE__ */ import_react9.default.createElement(
    "button",
    {
      type: "button",
      className: "cdx-rewound-text",
      disabled: !sessionId,
      title: fmtWhen(data.time) + ". Show checkpoints in Conductor, History.",
      onClick: () => sessionId && openSection2(sessionId, "history")
    },
    'Rewound to before "' + (data.label || "a checkpoint") + '"'
  ), /* @__PURE__ */ import_react9.default.createElement("span", { className: "cdx-rewound-line", "aria-hidden": "true" }));
}
function useVersionEntry(sessionId, pick) {
  const model = sessionId ? sessionModel(sessionId) : null;
  (0, import_react9.useEffect)(() => {
    if (model) model.ensure(6e4);
  }, [model]);
  const subscribe = (0, import_react9.useCallback)((fn) => model ? model.subscribe(fn) : () => {
  }, [model]);
  const get = () => {
    const view = model && model.getSnapshot().view;
    if (!view || !Array.isArray(view.versions)) return null;
    const entry = view.versions.find(pick);
    return entry && Array.isArray(entry.versions) && entry.versions.length > 1 ? entry : null;
  };
  return (0, import_react9.useSyncExternalStore)(subscribe, get, get);
}
function currentVersion(entry) {
  const list = entry.versions;
  return list.find((v) => v.v === entry.current) || list[list.length - 1];
}
function authorOf(v) {
  if (v.author === "original") return "original";
  return v.author === "model" ? "by the assistant" : "by you";
}
function VersionMarker({ sessionId, entry, onOpenTab, align }) {
  (0, import_react9.useEffect)(() => {
    ensureStyles();
  }, []);
  const [open, setOpen] = (0, import_react9.useState)(false);
  const [down, setDown] = (0, import_react9.useState)(false);
  const [busy, setBusy] = (0, import_react9.useState)(0);
  const [note, setNote] = (0, import_react9.useState)("");
  const ref = (0, import_react9.useRef)(null);
  const cur = currentVersion(entry);
  (0, import_react9.useEffect)(() => {
    if (!open) return void 0;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const restore = async (v) => {
    setBusy(v.v);
    setNote("");
    try {
      const r = await sessionApi(sessionId).restore(entry.messageId, v.v);
      setNote("Restored version " + v.v + " as version " + r.version + ".");
    } catch (e) {
      setNote("Could not restore: " + errorText(e));
    } finally {
      setBusy(0);
      sessionModel(sessionId).refresh().catch(() => {
      });
    }
  };
  return /* @__PURE__ */ import_react9.default.createElement("span", { className: "cdx-vmark" + (align === "end" ? " end" : ""), ref, "data-conductor-version": entry.messageId }, /* @__PURE__ */ import_react9.default.createElement(
    "button",
    {
      type: "button",
      className: "cdx-vchip",
      "aria-haspopup": "dialog",
      "aria-expanded": open,
      title: "Edited: the model sees version " + cur.v + ". Show all versions.",
      "aria-label": "Edited message, version " + cur.v + " of " + entry.versions.length + ". Show versions",
      onClick: () => {
        if (!open && ref.current) setDown(ref.current.getBoundingClientRect().top < 340);
        setOpen(!open);
      }
    },
    "v" + cur.v
  ), open ? /* @__PURE__ */ import_react9.default.createElement("span", { className: "cdx-vpop" + (down ? " down" : ""), role: "dialog", "aria-label": "Message versions" }, [...entry.versions].reverse().map((v) => /* @__PURE__ */ import_react9.default.createElement("span", { key: v.v, className: "cdx-vpop-row" }, /* @__PURE__ */ import_react9.default.createElement("span", { className: "cdx-vpop-head" }, /* @__PURE__ */ import_react9.default.createElement("b", null, "v" + v.v), /* @__PURE__ */ import_react9.default.createElement("span", null, authorOf(v) + (v.reason ? ": " + v.reason : "") + " \xB7 " + fmtWhen(v.at)), v.v === cur.v ? /* @__PURE__ */ import_react9.default.createElement("span", { className: "cdx-vpop-cur" }, "current") : /* @__PURE__ */ import_react9.default.createElement("button", { type: "button", className: "cdx-vpop-btn", disabled: busy !== 0, onClick: () => restore(v) }, busy === v.v ? "Restoring\u2026" : "Restore")), /* @__PURE__ */ import_react9.default.createElement("span", { className: "cdx-vpop-text" }, v.text.length > 600 ? v.text.slice(0, 600) + "\u2026" : v.text))), note ? /* @__PURE__ */ import_react9.default.createElement("span", { className: "cdx-vpop-note", role: "status" }, note) : null, onOpenTab ? /* @__PURE__ */ import_react9.default.createElement("button", { type: "button", className: "cdx-vpop-link", onClick: () => {
    setOpen(false);
    onOpenTab();
  } }, "Compare in Conductor") : null) : null);
}
function patchUserNode(node, text) {
  const data = node.data || {};
  const content = Array.isArray(data.content) ? data.content : [];
  const rest = content.filter((b) => !b || b.type !== "text");
  return { ...node, data: { ...data, content: [{ type: "text", text }, ...rest] } };
}
function patchAssistantNode(node, text) {
  const data = node.data || {};
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  const out = [];
  let placed = false;
  for (const b of blocks) {
    if (b && b.kind === "text") {
      if (!placed) {
        out.push({ kind: "text", text });
        placed = true;
      }
      continue;
    }
    out.push(b);
  }
  if (!placed) out.push({ kind: "text", text });
  const finalNode = data.finalNode ? { ...data.finalNode, blocks: out } : data.finalNode;
  return { ...node, data: { ...data, blocks: out, finalNode } };
}
function registerGhostDefinition(uiConversation, scope, effect2, warn2) {
  if (!uiConversation || !uiConversation.events || typeof uiConversation.events.register !== "function") {
    warn2("uiConversation.events unavailable; silent messages stay out of the chat view");
    return;
  }
  effect2(scope, () => uiConversation.events.register(ghostDefinition), "dsh-conductor: ghost messages in chat");
  effect2(scope, () => uiConversation.events.register(rewindDefinition), "dsh-conductor: rewind dividers in chat");
}
function registerChatRenderers(ctx, slots, effect2, warn2, openSection2) {
  const ours = /* @__PURE__ */ new Set();
  const GhostNode = function ConductorGhostNode(props) {
    return /* @__PURE__ */ import_react9.default.createElement(GhostView, { node: props.node, sessionId: props.conductorSessionId, openSection: openSection2 });
  };
  ours.add(GhostNode);
  effect2(ctx, () => slots.inject(NODE_SLOT, () => slots.register({
    name: NODE_SLOT,
    key: GHOST_KIND,
    inject: (sessionId) => ({ conductorSessionId: sessionId })
  }, GhostNode)), "dsh-conductor: ghost renderer");
  const RewindNode = function ConductorRewindNode(props) {
    return /* @__PURE__ */ import_react9.default.createElement(RewindDivider, { node: props.node, sessionId: props.conductorSessionId, openSection: openSection2 });
  };
  ours.add(RewindNode);
  effect2(ctx, () => slots.inject(NODE_SLOT, () => slots.register({
    name: NODE_SLOT,
    key: REWIND_KIND,
    inject: (sessionId) => ({ conductorSessionId: sessionId })
  }, RewindNode)), "dsh-conductor: rewind divider renderer");
  if (simulated()) {
    markUnavailable('simulated with localStorage "' + SIMULATE_KEY + '"');
    return;
  }
  if (typeof slots.entries !== "function") {
    markUnavailable("this DSH build does not list slot entries (slots.entries)");
    warn2("slots.entries unavailable; edited messages keep their original text in the chat view");
    return;
  }
  const capture = (key) => {
    let list;
    try {
      list = slots.entries(NODE_SLOT);
    } catch {
      list = null;
    }
    if (!Array.isArray(list)) return null;
    const entry = list.find((e) => e && e.component && e.options && e.options.key === key && !ours.has(e.component));
    return entry ? { component: entry.component, inject: entry.inject, children: entry.children, locale: entry.locale } : null;
  };
  const shadow = (key, make, label) => {
    effect2(ctx, () => slots.inject(NODE_SLOT, () => {
      let dispose = null;
      let stop = null;
      let timer = null;
      let tries = 0;
      let disposed = false;
      const cleanup = () => {
        if (stop) {
          try {
            stop();
          } catch {
          }
          stop = null;
        }
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const attempt = () => {
        if (dispose || disposed) return true;
        const base = capture(key);
        if (!base) return false;
        const { options, component } = make(base);
        ours.add(component);
        try {
          dispose = slots.register({ name: NODE_SLOT, key, priority: SHADOW_PRIORITY, ...options }, component);
        } catch (error) {
          cleanup();
          markUnavailable('registering the "' + key + '" renderer failed: ' + String(error && error.message || error));
          warn2('could not shadow the "' + key + '" chat renderer (' + String(error && error.message || error) + "); edited messages keep their original text");
          disposed = true;
          return true;
        }
        setHealth({ registered: { [key]: true }, since: shadowHealth.get().since || Date.now() });
        cleanup();
        return true;
      };
      const retry = () => {
        timer = null;
        if (attempt()) return;
        tries += 1;
        if (tries < 120) {
          timer = setTimeout(retry, 250);
          if (timer && typeof timer.unref === "function") timer.unref();
        } else {
          cleanup();
          markUnavailable('no built-in "' + key + '" chat renderer to delegate to');
          warn2('no built-in "' + key + '" chat renderer to delegate to; edited messages keep their original text');
        }
      };
      if (!attempt()) {
        if (typeof slots.subscribe === "function") {
          try {
            stop = slots.subscribe(NODE_SLOT, () => {
              attempt();
            });
          } catch {
            stop = null;
          }
        }
        timer = setTimeout(retry, 0);
        if (timer && typeof timer.unref === "function") timer.unref();
      }
      return () => {
        disposed = true;
        cleanup();
        if (dispose) dispose();
        dispose = null;
      };
    }), label);
  };
  shadow("user", (base) => {
    const Base = base.component;
    const component = import_react9.default.memo(function ConductorEditedUser(props) {
      const sessionId = props.conductorSessionId;
      const seq2 = props.node && props.node.data && props.node.data.seq;
      useSignal(settingsModel);
      const entry = useVersionEntry(moduleOn("versions") ? sessionId : null, (e) => e.role === "user" && e.origSeq === seq2);
      useRenderedMark("user", Boolean(entry));
      if (!entry) return /* @__PURE__ */ import_react9.default.createElement(Base, { ...props });
      return /* @__PURE__ */ import_react9.default.createElement("div", { className: "cdx-edited user", "data-conductor-edited": entry.messageId }, /* @__PURE__ */ import_react9.default.createElement(Base, { ...props, node: patchUserNode(props.node, currentVersion(entry).text) }), /* @__PURE__ */ import_react9.default.createElement(VersionMarker, { sessionId, entry, align: "end", onOpenTab: () => openSection2(sessionId, "history") }));
    });
    return { component, options: { ...base.locale ? { locale: base.locale } : {}, inject: mergeInject(base.inject) } };
  }, "dsh-conductor: edited user messages");
  shadow("assistant-step", (base) => {
    const Base = base.component;
    const component = import_react9.default.memo(function ConductorEditedAssistant(props) {
      const sessionId = props.conductorSessionId;
      const final = props.node && props.node.data && props.node.data.finalNode;
      const messageId = final && final.messageId;
      useSignal(settingsModel);
      const entry = useVersionEntry(moduleOn("versions") && messageId ? sessionId : null, (e) => e.messageId === messageId);
      const renderSlot = useChildSlots(slots, props.renderFactorySlot);
      useRenderedMark("assistant-step", Boolean(entry) && props.groupPart !== "reasoning");
      if (!entry || props.groupPart === "reasoning") return /* @__PURE__ */ import_react9.default.createElement(Base, { ...props, renderSlot });
      return /* @__PURE__ */ import_react9.default.createElement(Base, { ...props, renderSlot, node: patchAssistantNode(props.node, currentVersion(entry).text) });
    });
    return { component, options: { ...base.locale ? { locale: base.locale } : {}, inject: mergeInject(base.inject) } };
  }, "dsh-conductor: edited assistant answers");
}
var CHILD_FACTORIES = {
  "conversation.chat.reasoning.body": (owner) => ["conversation.chat.reasoning.content", { text: owner.text, running: owner.running }],
  "conversation.chat.message.images": (owner) => ["conversation.images.content", owner]
};
var ChildBoundary = class extends import_react9.default.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
};
function useChildSlots(slots, renderFactorySlot) {
  return import_react9.default.useMemo(() => (key, owner, opts) => {
    const viaFactory = () => {
      const make = CHILD_FACTORIES[key];
      if (!make || typeof renderFactorySlot !== "function") return opts && opts.fallback || null;
      const [name2, props] = make(owner || {});
      return renderFactorySlot(name2, props);
    };
    let winner = null;
    try {
      const list = typeof slots.entries === "function" ? slots.entries(key) : [];
      winner = Array.isArray(list) ? [...list].sort((a, b) => ((a.options && a.options.priority) ?? 0) - ((b.options && b.options.priority) ?? 0))[0] : null;
    } catch {
      winner = null;
    }
    if (!winner || !winner.component) return viaFactory();
    const Occupant = winner.component;
    return /* @__PURE__ */ import_react9.default.createElement(ChildBoundary, { fallback: viaFactory() }, /* @__PURE__ */ import_react9.default.createElement(Occupant, { ...owner || {}, renderFactorySlot }));
  }, [slots, renderFactorySlot]);
}
function mergeInject(baseInject) {
  return (...args) => {
    let injected = {};
    try {
      injected = typeof baseInject === "function" ? baseInject(...args) || {} : {};
    } catch {
      injected = {};
    }
    return { ...injected, conductorSessionId: args[0] };
  };
}
function AssistantVersionAction({ messageId, sessionId, openSection: openSection2 }) {
  useSignal(settingsModel);
  const entry = useVersionEntry(moduleOn("versions") && messageId ? sessionId : null, (e) => e.messageId === messageId);
  if (!entry) return null;
  return /* @__PURE__ */ import_react9.default.createElement(VersionMarker, { sessionId, entry, onOpenTab: () => openSection2(sessionId, "history") });
}
function GhostView({ node, sessionId, openSection: openSection2 }) {
  (0, import_react9.useEffect)(() => {
    ensureStyles();
  }, []);
  const data = node && node.data || {};
  const kind = data.kind === "report" || data.kind === "alert" ? data.kind : null;
  const when = data.at || data.time;
  return /* @__PURE__ */ import_react9.default.createElement("div", { className: "cdx-ghost", "data-conductor-ghost": data.messageId }, /* @__PURE__ */ import_react9.default.createElement("div", { className: "cdx-ghost-meta" }, /* @__PURE__ */ import_react9.default.createElement("span", { className: "cdx-ghost-from", title: data.from || data.summary }, data.from || "another chat"), /* @__PURE__ */ import_react9.default.createElement("span", { className: "cdx-ghost-time", title: fmtWhen(when) }, fmtHM(when)), /* @__PURE__ */ import_react9.default.createElement(
    "button",
    {
      type: "button",
      className: "cdx-ghost-tag",
      disabled: !sessionId,
      title: "A silent message: it did not wake this chat. Open the Inbox.",
      onClick: () => sessionId && openSection2(sessionId, "inbox")
    },
    "Ghost"
  ), kind ? /* @__PURE__ */ import_react9.default.createElement("span", { className: "cdx-ghost-kind " + kind }, kind === "alert" ? "Alert" : "Report") : null), /* @__PURE__ */ import_react9.default.createElement("div", { className: "cdx-ghost-bubble" }, data.body || data.summary || ""));
}

// src/client/sections/checkpoints.jsx
var import_react10 = __toESM(require("react"), 1);
var SCOPES = [
  { id: "both", label: "Chat and files", chat: true, files: true },
  { id: "chat", label: "Chat only", chat: true, files: false },
  { id: "files", label: "Files only", chat: false, files: true }
];
function checkpointTitle(cp) {
  return cp.name || cp.label || (cp.kind === "manual" ? "Checkpoint" : "Prompt");
}
function fileLine(f) {
  if (f.action === "keep") return "kept (" + (f.skipped || "not restorable") + ")";
  return f.action === "delete" ? "deleted (the agent created it)" : "restored";
}
function planSummary(files) {
  const list = Array.isArray(files) ? files : [];
  const restore = list.filter((f) => f.action === "restore" && !f.conflict).length;
  const del = list.filter((f) => f.action === "delete" && !f.conflict).length;
  const conflicts = list.filter((f) => f.conflict).length;
  if (!list.length) return "No file the agent edited changed since then.";
  const parts = [];
  if (restore) parts.push(restore + " " + plural(restore, "file") + " restored");
  if (del) parts.push(del + " " + plural(del, "file") + " deleted");
  let s = parts.join(", ") || "Nothing to restore";
  if (conflicts) s += "; " + conflicts + " changed outside the agent (kept unless you overwrite)";
  return s + ".";
}
function RewindPanel({ cp, api, model, sessionId, openSession, putDraft, onClose, busyAgent }) {
  const [plan, setPlan] = (0, import_react10.useState)(null);
  const [planError, setPlanError] = (0, import_react10.useState)(null);
  const [scope, setScope] = (0, import_react10.useState)("both");
  const [branch, setBranch] = (0, import_react10.useState)(false);
  const [force, setForce] = (0, import_react10.useState)(false);
  const [busy, setBusy] = (0, import_react10.useState)(false);
  const [result, setResult] = (0, import_react10.useState)(null);
  (0, import_react10.useEffect)(() => {
    let alive = true;
    api.checkpoints(cp.id).then((r) => {
      if (alive) setPlan(r.preview && r.preview.files || []);
    }, (e) => {
      if (alive) setPlanError(e);
    });
    return () => {
      alive = false;
    };
  }, [cp.id]);
  const s = SCOPES.find((x) => x.id === scope);
  const conflicts = (plan || []).filter((f) => f.conflict);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.rewind({ target: cp.id, chat: s.chat, files: s.files, branch, force: force && conflicts.length > 0 });
      setResult(r);
      const undoId = r.files && r.files.undoId;
      toast({
        message: r.text || "Rewound.",
        sessionId,
        undoLabel: "Undo file restore",
        undo: undoId ? async () => {
          const u = await api.rewindUndo();
          model.refresh().catch(() => {
          });
          return u.text || "Files put back.";
        } : null
      });
    } catch (e) {
      toastError("Could not rewind.", e, sessionId);
    } finally {
      setBusy(false);
      model.refresh().catch(() => {
      });
    }
  };
  if (result) {
    const prompt = result.prompt;
    return /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-rewind", role: "group", "aria-label": "Rewind result", "data-rewind-result": true, onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-text" }, result.text), /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-btnrow" }, result.newChat ? /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-btn s p", "data-open-branch": true, onClick: () => openSession(result.newChat) }, "Open the new chat") : null, prompt && putDraft ? /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-btn s", "data-put-prompt": true, onClick: () => {
      const ok = putDraft(sessionId, prompt);
      toast({ message: ok ? "The prompt is back in the input box." : "Could not reach the input box; the prompt was copied instead.", sessionId });
      if (!ok) copyText(prompt);
    } }, "Put the prompt back in the input box") : null, prompt && !putDraft ? /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-btn s", "data-copy-prompt": true, onClick: async () => {
      const ok = await copyText(prompt);
      toast({ message: ok ? "Prompt copied." : "Copy is not available in this browser.", sessionId });
    } }, "Copy the prompt") : null, result.files && result.files.undoId ? /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-btn s g", "data-undo-files": true, onClick: async () => {
      try {
        const u = await api.rewindUndo();
        toast({ message: u.text || "Files put back.", sessionId });
      } catch (e) {
        toastError("Could not undo the file restore.", e, sessionId);
      } finally {
        model.refresh().catch(() => {
        });
      }
    } }, "Undo file restore") : null, /* @__PURE__ */ import_react10.default.createElement("span", { className: "cdx-spacer" }), /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: onClose }, "Close")));
  }
  return /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-rewind", role: "group", "aria-label": "Rewind to before " + checkpointTitle(cp), "data-rewind-panel": true, onClick: (e) => e.stopPropagation(), onKeyDown: (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  } }, /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-help" }, 'Back to the moment before "' + excerpt(checkpointTitle(cp), 60) + '"'), /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-radio", role: "radiogroup", "aria-label": "What to rewind" }, SCOPES.map((x) => /* @__PURE__ */ import_react10.default.createElement("label", { key: x.id }, /* @__PURE__ */ import_react10.default.createElement("input", { type: "radio", name: "cdx-scope-" + cp.id, checked: scope === x.id, onChange: () => setScope(x.id) }), x.label))), s.chat ? /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-help" }, "Chat: everything after this point leaves the model context. It stays visible above and is archived; this part has no undo.") : null, s.files ? /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-plan", "data-file-plan": true }, planError ? /* @__PURE__ */ import_react10.default.createElement("span", { className: "cdx-help" }, "Could not load the file preview: " + errorText(planError)) : plan === null ? /* @__PURE__ */ import_react10.default.createElement("span", { className: "cdx-help" }, "Checking files\\u2026") : /* @__PURE__ */ import_react10.default.createElement(import_react10.default.Fragment, null, /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-help" }, "Files: " + planSummary(plan)), plan.length ? /* @__PURE__ */ import_react10.default.createElement("ul", { className: "cdx-flist" }, plan.slice(0, 12).map((f) => /* @__PURE__ */ import_react10.default.createElement("li", { key: f.path, className: f.conflict ? "conflict" : "" }, /* @__PURE__ */ import_react10.default.createElement("span", { className: "cdx-ell cdx-lell", title: f.path }, "\u200E" + f.path + "\u200E"), /* @__PURE__ */ import_react10.default.createElement("span", { className: "cdx-help" }, f.conflict ? "changed outside the agent" : fileLine(f)))), plan.length > 12 ? /* @__PURE__ */ import_react10.default.createElement("li", { className: "cdx-help" }, "and " + (plan.length - 12) + " more") : null) : null, /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-help" }, "Changes made by shell commands are not tracked."))) : null, /* @__PURE__ */ import_react10.default.createElement("label", { className: "cdx-check2" }, /* @__PURE__ */ import_react10.default.createElement("input", { type: "checkbox", checked: branch, onChange: (e) => setBranch(e.target.checked) }), "Continue in a new chat (this chat stays as it is)"), s.files && conflicts.length ? /* @__PURE__ */ import_react10.default.createElement("label", { className: "cdx-check2 warn" }, /* @__PURE__ */ import_react10.default.createElement("input", { type: "checkbox", checked: force, onChange: (e) => setForce(e.target.checked) }), "Overwrite " + conflicts.length + " " + plural(conflicts.length, "file") + " changed outside the agent") : null, /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-btn s d", "data-rewind-confirm": true, disabled: busy || busyAgent, title: busyAgent ? "The agent is working. Rewind when it has finished." : void 0, onClick: run }, busy ? "Rewinding\u2026" : branch ? "Create the new chat" : "Rewind"), /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: onClose }, "Cancel")));
}
function CheckpointsBlock({ sessionId, view, api, model, openSession, putDraft }) {
  const cps = view.checkpoints || [];
  const [open, setOpen] = (0, import_react10.useState)(null);
  const [naming, setNaming] = (0, import_react10.useState)(null);
  const [showAll, setShowAll] = (0, import_react10.useState)(false);
  const busyAgent = view.status === "running";
  const save = async () => {
    try {
      const r = await api.checkpoint((naming || "").trim() || void 0);
      toast({ message: r.text || "Checkpoint set.", sessionId });
      setNaming(null);
    } catch (e) {
      toastError("Could not set a checkpoint.", e, sessionId);
    } finally {
      model.refresh().catch(() => {
      });
    }
  };
  const shown = showAll ? cps : cps.slice(0, 6);
  return /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-cps", "data-checkpoints": true }, /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-phead" }, /* @__PURE__ */ import_react10.default.createElement("span", { className: "cdx-help" }, "Checkpoints"), /* @__PURE__ */ import_react10.default.createElement("span", { className: "cdx-spacer" }), naming === null ? /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-link", "data-set-checkpoint": true, onClick: () => setNaming("") }, "Set checkpoint") : null), naming !== null ? /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-btnrow", style: { padding: "0 14px 8px" } }, /* @__PURE__ */ import_react10.default.createElement(
    "input",
    {
      className: "cdx-in s",
      style: { flex: "1 1 120px", width: "auto" },
      placeholder: "Name (optional)",
      "aria-label": "Checkpoint name",
      value: naming,
      autoFocus: true,
      onChange: (e) => setNaming(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") {
          e.stopPropagation();
          setNaming(null);
        }
      }
    }
  ), /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-btn s p", "data-save-checkpoint": true, onClick: save }, "Set"), /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => setNaming(null) }, "Cancel")) : null, !cps.length ? /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-empty", style: { paddingTop: 2 } }, "A checkpoint is set before every prompt. Rewind brings the chat and the agent's file edits back to one.") : /* @__PURE__ */ import_react10.default.createElement("ul", { className: "cdx-list plain", "aria-label": "Checkpoints" }, shown.map((cp) => {
    const isOpen = open === cp.id;
    const auto = cp.kind === "turn" && cp.auto;
    return /* @__PURE__ */ import_react10.default.createElement("li", { key: cp.id }, /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-row cdx-cp" + (auto ? " auto" : "") + (isOpen ? " open" : ""), "data-checkpoint": cp.id, style: { gridTemplateColumns: "40px minmax(0,1fr) auto", alignItems: "start" } }, /* @__PURE__ */ import_react10.default.createElement("span", { className: "cdx-num cdx-when", title: fmtWhen(cp.at) }, fmtWhen(cp.at).replace(/^today /, "")), /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-main" }, /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-title" }, cp.kind === "manual" ? /* @__PURE__ */ import_react10.default.createElement("span", { className: "cdx-chip clay" }, "checkpoint") : null, /* @__PURE__ */ import_react10.default.createElement("span", { title: checkpointTitle(cp) }, excerpt(checkpointTitle(cp), 80))), /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react10.default.createElement("span", null, [auto ? "automatic turn" : cp.kind === "manual" ? "set by hand" : "your prompt", cp.files ? cp.files + " " + plural(cp.files, "file") + " edited" : "", fmtAgo(cp.at)].filter(Boolean).join(" \xB7 ")))), /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-btn s g", "data-rewind": cp.id, "aria-expanded": isOpen, onClick: () => setOpen(isOpen ? null : cp.id) }, "Rewind"), isOpen ? /* @__PURE__ */ import_react10.default.createElement("div", { style: { gridColumn: "1 / -1" } }, /* @__PURE__ */ import_react10.default.createElement(RewindPanel, { cp, api, model, sessionId, openSession, putDraft, busyAgent, onClose: () => setOpen(null) })) : null));
  })), cps.length > 6 ? /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-panelfoot", style: { paddingTop: 2 } }, /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-link", onClick: () => setShowAll(!showAll) }, showAll ? "Fewer" : "All " + cps.length + " checkpoints")) : null);
}
var KIND_LABEL = { archive: "archive", dropped: "dropped", handoff: "handoff" };
function RecallBox({ sessionId, api, openFile }) {
  const [q, setQ] = (0, import_react10.useState)("");
  const [busy, setBusy] = (0, import_react10.useState)(false);
  const [res, setRes] = (0, import_react10.useState)(null);
  const [error, setError] = (0, import_react10.useState)(null);
  const search = async (e) => {
    if (e) e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setRes(await api.recall(q.trim()));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-recall", "data-recall": true }, /* @__PURE__ */ import_react10.default.createElement("form", { className: "cdx-btnrow", style: { padding: "6px 14px 8px" }, onSubmit: search, role: "search" }, /* @__PURE__ */ import_react10.default.createElement(
    "input",
    {
      className: "cdx-in s",
      type: "search",
      style: { flex: "1 1 140px", width: "auto" },
      placeholder: "Search earlier context",
      "aria-label": "Search earlier context",
      value: q,
      onChange: (e) => setQ(e.target.value),
      onKeyDown: (e) => {
        if (e.key === "Escape" && res) {
          e.stopPropagation();
          setRes(null);
        }
      }
    }
  ), /* @__PURE__ */ import_react10.default.createElement("button", { type: "submit", className: "cdx-btn s", disabled: busy || !q.trim() }, busy ? "Searching\u2026" : "Search")), error ? /* @__PURE__ */ import_react10.default.createElement(Note, { tone: "bad", role: "alert" }, "Search failed: " + errorText(error)) : null, res ? /* @__PURE__ */ import_react10.default.createElement("div", { "aria-live": "polite" }, /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-phead", style: { paddingTop: 0 } }, /* @__PURE__ */ import_react10.default.createElement("span", { className: "cdx-help" }, res.hits && res.hits.length ? res.hits.length + " " + plural(res.hits.length, "result") + " in " + (res.searched || 0) + " " + plural(res.searched || 0, "file") : res.error || "Nothing found in " + (res.searched || 0) + " " + plural(res.searched || 0, "file") + "."), /* @__PURE__ */ import_react10.default.createElement("span", { className: "cdx-spacer" }), /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-link", onClick: () => setRes(null) }, "Clear")), /* @__PURE__ */ import_react10.default.createElement("ul", { className: "cdx-list plain", "aria-label": "Search results" }, (res.hits || []).map((h, i) => /* @__PURE__ */ import_react10.default.createElement("li", { key: i, className: "cdx-row", "data-recall-hit": true, style: { gridTemplateColumns: "minmax(0,1fr) auto", alignItems: "start" } }, /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-main" }, /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react10.default.createElement("span", { className: "cdx-chip" }, KIND_LABEL[h.kind] || h.kind), /* @__PURE__ */ import_react10.default.createElement("span", null, (h.when ? fmtWhen(h.when) + " \xB7 " : "") + "line " + h.line)), /* @__PURE__ */ import_react10.default.createElement("div", { className: "cdx-snippet" }, String(h.snippet || "").slice(0, 400))), /* @__PURE__ */ import_react10.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => openFile(h.path), title: h.path }, "Open"))))) : null);
}

// src/client/sections/history.jsx
function DiffView({ before, after }) {
  const parts = (0, import_react11.useMemo)(() => wordDiff(before, after), [before, after]);
  return /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-diff", "data-diff": true }, parts.map((p, i) => p.type === "add" ? /* @__PURE__ */ import_react11.default.createElement("ins", { key: i }, p.text) : p.type === "del" ? /* @__PURE__ */ import_react11.default.createElement("del", { key: i }, p.text) : /* @__PURE__ */ import_react11.default.createElement("span", { key: i }, p.text)));
}
function authorLabel(author) {
  if (author === "original") return "original";
  if (author === "model" || author === "the assistant") return "by the assistant";
  return "by you";
}
function VersionBody({ entry, api, model, sessionId }) {
  const versions = entry.versions || [];
  const current = entry.current || (versions.length ? versions[versions.length - 1].v : 1);
  const [chosen, setChosen] = (0, import_react11.useState)(current);
  const [busy, setBusy] = (0, import_react11.useState)(false);
  const pick = versions.find((v) => v.v === chosen) || versions[versions.length - 1];
  const prev = pick ? versions.find((v) => v.v === pick.v - 1) : null;
  if (!pick) return null;
  const restore = async () => {
    setBusy(true);
    try {
      const r = await api.restore(entry.messageId, pick.v);
      toast({ message: "Restored version " + pick.v + " as version " + r.version + ". Nothing was deleted.", sessionId });
    } catch (e) {
      toastError("Could not restore that version.", e, sessionId);
    } finally {
      setBusy(false);
      model.refresh().catch(() => {
      });
    }
  };
  const delta = prev ? tokenDelta(prev.text, pick.text) : 0;
  return /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-detail", style: { gridColumn: "1 / -1" }, onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-vlist", role: "group", "aria-label": "Versions" }, [...versions].reverse().map((v) => /* @__PURE__ */ import_react11.default.createElement("button", { key: v.v, type: "button", className: "cdx-vrow", "aria-pressed": v.v === pick.v, onClick: () => setChosen(v.v) }, /* @__PURE__ */ import_react11.default.createElement("span", { className: "cdx-num", style: { width: 24 } }, "v" + v.v), /* @__PURE__ */ import_react11.default.createElement("span", { className: "cdx-grow cdx-ell" }, authorLabel(v.author) + (v.reason ? ": " + v.reason : "")), v.v === current ? /* @__PURE__ */ import_react11.default.createElement("span", { className: "cdx-chip clay" }, "current") : null, /* @__PURE__ */ import_react11.default.createElement("span", { className: "cdx-help" }, fmtWhen(v.at))))), prev ? /* @__PURE__ */ import_react11.default.createElement(import_react11.default.Fragment, null, /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-help" }, "v" + prev.v + " to v" + pick.v + " \xB7 " + (delta >= 0 ? "+" : "") + delta + " tokens"), /* @__PURE__ */ import_react11.default.createElement(DiffView, { before: prev.text, after: pick.text })) : /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-diff" }, pick.text), /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-btnrow" }, pick.v !== current ? /* @__PURE__ */ import_react11.default.createElement("button", { type: "button", className: "cdx-btn s", disabled: busy, onClick: restore }, "Restore version " + pick.v) : null, /* @__PURE__ */ import_react11.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: async () => {
    const ok = await copyText(pick.text);
    toast({ message: ok ? "Copied version " + pick.v + "." : "Copy is not available in this browser.", sessionId });
  } }, "Copy")));
}
function historyEvents(view) {
  const out = [];
  const epochs = view.epochs || [];
  epochs.forEach((e, i) => out.push({ type: "reset", at: e.at, key: "ep:" + e.id, epoch: e, n: epochs.length - i }));
  for (const entry of view.versions || []) {
    const versions = entry.versions || [];
    if (versions.length < 2) continue;
    const last = versions[versions.length - 1];
    out.push({ type: "edit", at: last.at, key: "v:" + entry.messageId, entry });
  }
  for (const [i, a] of (view.activity || []).entries()) {
    if (a.kind === "reset" || a.kind === "edit" || a.kind === "rewind") continue;
    out.push({ type: a.kind === "error" ? "error" : "other", at: a.at, key: "a:" + i + ":" + a.at, activity: a });
  }
  return out.sort((a, b) => (toMs(b.at) || 0) - (toMs(a.at) || 0));
}
var FILTERS = [
  { id: "all", label: "All" },
  { id: "reset", label: "Resets" },
  { id: "edit", label: "Edits" },
  { id: "other", label: "Other" }
];
function RewindRow({ ev, api, model, sessionId, latest }) {
  const e = ev.epoch;
  const undo = async () => {
    try {
      const u = await api.rewindUndo();
      toast({ message: u.text || "Files put back.", sessionId });
    } catch (err) {
      toastError("Could not undo the file restore.", err, sessionId);
    } finally {
      model.refresh().catch(() => {
      });
    }
  };
  return /* @__PURE__ */ import_react11.default.createElement(import_react11.default.Fragment, null, /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react11.default.createElement("span", null, "Rewind" + (e.branch ? " to a new chat" : ""))), /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react11.default.createElement("span", null, [e.files ? e.files + " " + plural(e.files, "file") + " restored" : "", byLabel(e.by)].filter(Boolean).join(" \xB7 "))), latest && e.files ? /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-btnrow", style: { marginTop: 2 } }, /* @__PURE__ */ import_react11.default.createElement("button", { type: "button", className: "cdx-link", "data-timeline-undo": true, onClick: undo }, "Undo file restore")) : null);
}
function ResetRow({ ev, openFile }) {
  const e = ev.epoch;
  const before = e.tokensBefore;
  const after = e.tokensAfter;
  const known = Number.isFinite(before) && Number.isFinite(after);
  return /* @__PURE__ */ import_react11.default.createElement(import_react11.default.Fragment, null, /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react11.default.createElement("span", null, epochLabel(e.kind) + " \xB7 epoch " + ev.n)), /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react11.default.createElement("span", null, (Number.isFinite(before) ? fmtTokens(before) : "?") + " to " + (Number.isFinite(after) ? fmtTokens(after) : "measuring") + " tokens" + (known && before > after ? " \xB7 saved " + fmtTokens(before - after) : "") + " \xB7 " + byLabel(e.by))), e.handoff || e.archive ? /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-btnrow", style: { gap: 14, marginTop: 2 } }, e.handoff ? /* @__PURE__ */ import_react11.default.createElement("button", { type: "button", className: "cdx-link", onClick: () => openFile(e.handoff), title: e.handoff }, "View handoff") : null, e.archive ? /* @__PURE__ */ import_react11.default.createElement("button", { type: "button", className: "cdx-link", onClick: () => openFile(e.archive), title: e.archive }, "View archive") : null) : null);
}
function HistoryPanel({ sessionId, view, api, model, openFile, openSession, putDraft }) {
  const [filter, setFilter] = (0, import_react11.useState)("all");
  const [open, setOpen] = (0, import_react11.useState)(null);
  const [limit, setLimit] = (0, import_react11.useState)(60);
  const all = (0, import_react11.useMemo)(() => historyEvents(view), [view.epochs, view.versions, view.activity]);
  const counts = (0, import_react11.useMemo)(() => ({ reset: all.filter((e) => e.type === "reset").length, edit: all.filter((e) => e.type === "edit").length }), [all]);
  const fallback = useEditFallback(view);
  const shown = all.filter((e) => filter === "all" || e.type === filter || filter === "other" && e.type === "error").slice(0, limit);
  const latestRewind = all.find((e) => e.type === "reset" && e.epoch.kind === "rewind");
  const top = /* @__PURE__ */ import_react11.default.createElement(import_react11.default.Fragment, null, /* @__PURE__ */ import_react11.default.createElement(CheckpointsBlock, { sessionId, view, api, model, openSession, putDraft }), /* @__PURE__ */ import_react11.default.createElement(RecallBox, { sessionId, api, openFile }));
  if (!all.length) return /* @__PURE__ */ import_react11.default.createElement("div", null, top, /* @__PURE__ */ import_react11.default.createElement(Empty, { title: "Nothing yet" }, "Resets, edited messages, drops and pins appear here, newest first."));
  return /* @__PURE__ */ import_react11.default.createElement("div", null, top, fallback ? /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-fallback", role: "note", "data-edit-fallback": true, title: "Reason: " + fallback }, FALLBACK_NOTICE) : null, /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-phead", style: { paddingBottom: 0 } }, /* @__PURE__ */ import_react11.default.createElement("span", { className: "cdx-help" }, "Timeline")), counts.reset + counts.edit > 0 ? /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-phead", role: "group", "aria-label": "Filter history" }, FILTERS.map((f) => /* @__PURE__ */ import_react11.default.createElement("button", { key: f.id, type: "button", className: "cdx-chipbtn", "aria-pressed": filter === f.id, onClick: () => setFilter(f.id) }, f.label))) : null, !shown.length ? /* @__PURE__ */ import_react11.default.createElement(Empty, { title: "Nothing of this kind" }) : null, /* @__PURE__ */ import_react11.default.createElement("ul", { className: "cdx-list plain cdx-timeline", "aria-label": "History" }, shown.map((ev) => {
    const isOpen = open === ev.key;
    const expandable = ev.type === "edit";
    return /* @__PURE__ */ import_react11.default.createElement("li", { key: ev.key }, /* @__PURE__ */ import_react11.default.createElement(
      "div",
      {
        className: "cdx-row" + (expandable ? " click" : "") + (isOpen ? " open" : ""),
        "data-history": ev.type,
        tabIndex: expandable ? 0 : void 0,
        "aria-expanded": expandable ? isOpen : void 0,
        onClick: expandable ? () => setOpen(isOpen ? null : ev.key) : void 0,
        onKeyDown: expandable ? (e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen(isOpen ? null : ev.key);
          }
        } : void 0,
        style: { gridTemplateColumns: "40px minmax(0,1fr)", alignItems: "start" }
      },
      /* @__PURE__ */ import_react11.default.createElement("span", { className: "cdx-num cdx-when", title: fmtWhen(ev.at) }, fmtHM(ev.at)),
      /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-main" }, ev.type === "reset" && ev.epoch.kind === "rewind" ? /* @__PURE__ */ import_react11.default.createElement(RewindRow, { ev, api, model, sessionId, latest: ev === latestRewind }) : null, ev.type === "reset" && ev.epoch.kind !== "rewind" ? /* @__PURE__ */ import_react11.default.createElement(ResetRow, { ev, openFile }) : null, ev.type === "edit" ? /* @__PURE__ */ import_react11.default.createElement(import_react11.default.Fragment, null, /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react11.default.createElement("span", null, (ev.entry.role === "user" ? "Edited your message" : "Edited an answer") + " \xB7 v" + (ev.entry.current || ev.entry.versions.length))), /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react11.default.createElement("span", null, excerpt(ev.entry.versions[ev.entry.versions.length - 1].text, 90) + " \xB7 " + ev.entry.versions.length + " " + plural(ev.entry.versions.length, "version"))), fallback ? /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-meta warn", "data-edit-fallback-row": true }, /* @__PURE__ */ import_react11.default.createElement("span", null, "The chat shows the original text; the model sees this version.")) : null) : null, ev.type === "other" || ev.type === "error" ? /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-line" + (ev.type === "error" ? " bad" : "") }, ev.activity.text, ev.activity.by && ev.activity.by !== "user" ? /* @__PURE__ */ import_react11.default.createElement("span", { className: "cdx-help" }, " \xB7 " + byLabel(ev.activity.by)) : null) : null),
      isOpen ? /* @__PURE__ */ import_react11.default.createElement(VersionBody, { entry: ev.entry, api, model, sessionId }) : null
    ));
  })), shown.length >= limit ? /* @__PURE__ */ import_react11.default.createElement("div", { className: "cdx-more" }, /* @__PURE__ */ import_react11.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => setLimit(limit + 100) }, "Load older")) : null);
}

// src/client/sections/orchestration.jsx
var import_react12 = __toESM(require("react"), 1);
var enc2 = encodeURIComponent;
var POLL_MS = 4e3;
function agentDot(row) {
  if (row.running) return "cdx-dot live pulse";
  if (row.live) return "cdx-dot ok";
  return "cdx-dot idle";
}
function SpawnForm({ onDone, sessionId }) {
  const [title, setTitle] = (0, import_react12.useState)("");
  const [prompt, setPrompt] = (0, import_react12.useState)("");
  const [count, setCount] = (0, import_react12.useState)(1);
  const [preset, setPreset] = (0, import_react12.useState)("");
  const [cwd, setCwd] = (0, import_react12.useState)("");
  const [busy, setBusy] = (0, import_react12.useState)(false);
  const [error, setError] = (0, import_react12.useState)("");
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await post("/agents/spawn", { title, prompt, count, preset, cwd });
      const n = (r && r.created || []).length;
      toast({ message: "Spawned " + n + " " + plural(n, "chat") + (prompt.trim() ? " with a first prompt." : "."), sessionId });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ import_react12.default.createElement("form", { className: "cdx-form", onSubmit: submit, "aria-label": "Spawn agent", "data-spawn-form": true }, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-frow" }, /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Title (addressable by name)"), /* @__PURE__ */ import_react12.default.createElement("input", { className: "cdx-in", value: title, onChange: (e) => setTitle(e.target.value), placeholder: "research-{i}" })), /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field", style: { flex: "0 0 64px" } }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Count"), /* @__PURE__ */ import_react12.default.createElement("input", { className: "cdx-in", type: "number", min: 1, max: 8, value: count, onChange: (e) => setCount(Math.max(1, Math.min(8, Number(e.target.value) || 1))) }))), /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "First prompt"), /* @__PURE__ */ import_react12.default.createElement("textarea", { className: "cdx-in", rows: 3, value: prompt, onChange: (e) => setPrompt(e.target.value), placeholder: "What the agent should do. {i} becomes 1 to N when count is above 1." })), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-frow" }, /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Preset (optional)"), /* @__PURE__ */ import_react12.default.createElement("input", { className: "cdx-in", value: preset, onChange: (e) => setPreset(e.target.value), placeholder: "deployment default" })), /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Working directory (optional)"), /* @__PURE__ */ import_react12.default.createElement("input", { className: "cdx-in", value: cwd, onChange: (e) => setCwd(e.target.value), placeholder: "server default" }))), error ? /* @__PURE__ */ import_react12.default.createElement(Note, { tone: "bad", role: "alert" }, error) : null, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react12.default.createElement("button", { type: "submit", className: "cdx-btn p s", disabled: busy || !prompt.trim() && !title.trim() }, busy ? "Spawning\u2026" : prompt.trim() ? "Spawn and prompt" : "Spawn"), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: onDone }, "Cancel")));
}
function AgentDetail({ row, sessionId, openSession, onPost }) {
  const [data, setData] = (0, import_react12.useState)(null);
  const [error, setError] = (0, import_react12.useState)(null);
  const [text, setText] = (0, import_react12.useState)("");
  const [sending, setSending] = (0, import_react12.useState)(false);
  const box = (0, import_react12.useRef)(null);
  const load = (0, import_react12.useCallback)(() => getJson("/agents/" + enc2(row.sessionId) + "/transcript?max=12").then((t) => {
    setData(t);
    setError(null);
  }, setError), [row.sessionId]);
  (0, import_react12.useEffect)(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  (0, import_react12.useEffect)(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [data]);
  const send = async () => {
    const message = text.trim();
    if (!message) return;
    setSending(true);
    try {
      await post("/agents/" + enc2(row.sessionId) + "/prompt", { message });
      setText("");
      toast({ message: "Message sent to " + (row.title || shortId(row.sessionId)) + ".", sessionId });
      load();
      refreshStatus();
    } catch (e) {
      toastError("Could not send the message.", e, sessionId);
    } finally {
      setSending(false);
    }
  };
  const fork = async () => {
    try {
      const r = await post("/agents/fork", { agent: row.sessionId });
      toast({ message: "Forked into a new chat.", sessionId, undoLabel: "Open", undo: r.sessionId ? async () => {
        openSession(r.sessionId);
        return "Opened the fork.";
      } : null });
      refreshStatus();
    } catch (e) {
      toastError("Could not fork the chat.", e, sessionId);
    }
  };
  const messages = data && data.messages || [];
  return /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-detail", onClick: (e) => e.stopPropagation() }, error ? /* @__PURE__ */ import_react12.default.createElement(SectionError, { what: "the transcript", error, onRetry: load }) : null, /* @__PURE__ */ import_react12.default.createElement("div", { ref: box, style: { maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 } }, !data && !error ? /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-help" }, "Loading the transcript\\u2026") : null, data && !messages.length ? /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-help" }, "No messages yet.") : null, messages.map((m, i) => /* @__PURE__ */ import_react12.default.createElement("div", { key: i, style: { borderLeft: "2px solid " + (m.role === "user" ? "var(--line)" : "var(--c-instr)"), padding: "1px 0 1px 8px" } }, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-help", style: { textTransform: "uppercase", letterSpacing: ".05em", fontSize: 10 } }, m.role === "user" ? "Prompt" : "Agent"), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-text", style: { fontSize: 12 } }, String(m.text || "").slice(0, 4e3))))), /* @__PURE__ */ import_react12.default.createElement(
    "textarea",
    {
      className: "cdx-in",
      rows: 2,
      value: text,
      onChange: (e) => setText(e.target.value),
      "aria-label": "Message to " + (row.title || row.sessionId),
      placeholder: "Message this chat (Ctrl+Enter to send)",
      onKeyDown: (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          send();
        }
      }
    }
  ), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn p s", disabled: sending || !text.trim(), onClick: send }, sending ? "Sending\u2026" : "Send"), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => openSession(row.sessionId) }, Icon.open(13), "Open"), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: fork }, Icon.fork(13), "Fork"), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => onPost(row.sessionId) }, Icon.send(13), "Post silently")));
}
function AgentsBlock({ data, sessionId, openSession }) {
  const [scope, setScope] = (0, import_react12.useState)("mine");
  const [spawn, setSpawn] = (0, import_react12.useState)(false);
  const [open, setOpen] = (0, import_react12.useState)(null);
  const [postTo, setPostTo] = (0, import_react12.useState)(null);
  const [busy, setBusy] = (0, import_react12.useState)("");
  const all = data && data.agents && data.agents.rows || [];
  const rows = (0, import_react12.useMemo)(() => {
    if (scope === "all" || !sessionId) return all;
    const me = all.find((r) => r.sessionId === sessionId);
    const parent = me && me.parentSessionId;
    return all.filter((r) => r.sessionId !== sessionId && (r.parentSessionId === sessionId || parent && r.sessionId === parent || parent && r.parentSessionId === parent));
  }, [all, scope, sessionId]);
  const cancel = async (row) => {
    setBusy(row.sessionId);
    try {
      await post("/agents/" + enc2(row.sessionId) + "/cancel", {});
      toast({ message: "Asked " + (row.title || shortId(row.sessionId)) + " to stop.", sessionId });
      refreshStatus();
    } catch (e) {
      toastError("Could not stop the agent.", e, sessionId);
    } finally {
      setBusy("");
    }
  };
  return /* @__PURE__ */ import_react12.default.createElement("div", null, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-sub" }, "Agents", /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-spacer" }), sessionId ? /* @__PURE__ */ import_react12.default.createElement("span", { role: "group", "aria-label": "Which chats", style: { display: "inline-flex" } }, /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-chipbtn", "aria-pressed": scope === "mine", onClick: () => setScope("mine") }, "This chat"), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-chipbtn", "aria-pressed": scope === "all", onClick: () => setScope("all") }, "All")) : null, /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s", "aria-expanded": spawn, onClick: () => setSpawn(!spawn) }, Icon.plus(12), "Spawn agent")), data && data.agents && data.agents.degraded ? /* @__PURE__ */ import_react12.default.createElement(Note, { tone: "warn" }, "The session catalog is partly degraded, so only live agents are listed.") : null, spawn ? /* @__PURE__ */ import_react12.default.createElement(SpawnForm, { sessionId, onDone: () => {
    setSpawn(false);
    refreshStatus();
  } }) : null, postTo ? /* @__PURE__ */ import_react12.default.createElement(PostForm, { sessionId, initialTarget: postTo, onDone: () => setPostTo(null) }) : null, !rows.length ? /* @__PURE__ */ import_react12.default.createElement(Empty, { title: scope === "mine" ? "No other chats running" : "No chats" }, scope === "mine" ? "Spawn an agent to work on a task in parallel. Subagents and forks of this chat appear here." : "Spawn an agent to work on a task in parallel.") : /* @__PURE__ */ import_react12.default.createElement("ul", { className: "cdx-list", "aria-label": "Agents" }, rows.slice(0, 60).map((row) => /* @__PURE__ */ import_react12.default.createElement("li", { key: row.sessionId }, /* @__PURE__ */ import_react12.default.createElement(
    "div",
    {
      className: "cdx-row click" + (open === row.sessionId ? " open" : ""),
      tabIndex: 0,
      "aria-expanded": open === row.sessionId,
      "data-agent": row.sessionId,
      onClick: () => setOpen(open === row.sessionId ? null : row.sessionId),
      onKeyDown: (e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          setOpen(open === row.sessionId ? null : row.sessionId);
        }
      }
    },
    /* @__PURE__ */ import_react12.default.createElement("span", { className: agentDot(row), "aria-label": row.running ? "Working" : row.live ? "Live" : "Idle", role: "img" }),
    /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-main" }, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react12.default.createElement("span", { title: row.sessionId }, row.title || "(untitled)"), row.sessionId === sessionId ? /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-chip" }, "this chat") : null), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react12.default.createElement("span", null, (row.running ? "working" : row.live ? "live" : "idle") + " \xB7 " + (fmtAgo(row.updatedAt) || "unknown") + (row.origin === "subagent" ? " \xB7 subagent" : "") + " \xB7 " + shortId(row.sessionId)))),
    /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-side" }, /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-acts" }, /* @__PURE__ */ import_react12.default.createElement(IconButton, { label: "Open " + (row.title || "chat"), onClick: () => openSession(row.sessionId) }, Icon.open(13))), row.running ? /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s d", style: { marginLeft: 6 }, disabled: busy === row.sessionId, onClick: (e) => {
      e.stopPropagation();
      cancel(row);
    } }, "Cancel") : null),
    open === row.sessionId ? /* @__PURE__ */ import_react12.default.createElement(AgentDetail, { row, sessionId, openSession, onPost: (id) => {
      setOpen(null);
      setPostTo(id);
    } }) : null
  )))));
}
var TYPES = ["command", "scrape", "http", "agent"];
var STATUS_DOT = { queued: "cdx-dot idle", running: "cdx-dot live pulse", completed: "cdx-dot ok", failed: "cdx-dot bad", cancelled: "cdx-dot warn", interrupted: "cdx-dot warn" };
function TaskOutput({ t, sessionId }) {
  const [out, setOut] = (0, import_react12.useState)(null);
  const [follow, setFollow] = (0, import_react12.useState)(true);
  const ref = (0, import_react12.useRef)(null);
  (0, import_react12.useEffect)(() => {
    let alive = true;
    const load = () => getJson("/tasks/" + enc2(t.id) + "/output?tail=8000").then((j) => {
      if (alive) setOut(j);
    }, () => {
    });
    load();
    const timer = t.status === "running" || t.status === "queued" ? setInterval(load, POLL_MS) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [t.id, t.status]);
  (0, import_react12.useEffect)(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [out, follow]);
  const text = out && out.output || t.outputPreview || "";
  return /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-detail", onClick: (e) => e.stopPropagation() }, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-meta", style: { flexWrap: "wrap", whiteSpace: "normal" } }, /* @__PURE__ */ import_react12.default.createElement("span", null, "status " + t.status), t.via ? /* @__PURE__ */ import_react12.default.createElement("span", null, "via " + t.via) : null, t.agentSessionId ? /* @__PURE__ */ import_react12.default.createElement("span", null, "chat " + shortId(t.agentSessionId)) : null, t.detail ? /* @__PURE__ */ import_react12.default.createElement("span", { title: t.detail }, t.detail) : null), /* @__PURE__ */ import_react12.default.createElement("pre", { className: "cdx-pre log", ref, "data-task-output": true }, text || "(no output yet)"), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-help", style: { display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" } }, /* @__PURE__ */ import_react12.default.createElement("input", { type: "checkbox", checked: follow, onChange: (e) => setFollow(e.target.checked), style: { accentColor: "var(--clay)", margin: 0 } }), "Following"), /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-spacer" }), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: async () => {
    const ok = await copyText(text);
    toast({ message: ok ? "Copied the task log." : "Copy is not available in this browser.", sessionId });
  } }, "Copy log")));
}
function duration(t, now) {
  const start = toMs(t.startedAt) || toMs(t.createdAt);
  if (!Number.isFinite(start)) return "";
  const end = toMs(t.finishedAt);
  return fmtClock((Number.isFinite(end) ? end : now) - start);
}
function NewTaskForm({ runners, sessionId, commandsAllowed, onDone }) {
  const [type, setType] = (0, import_react12.useState)(commandsAllowed ? "command" : "scrape");
  const [f, setF] = (0, import_react12.useState)({ title: "", runner: "", command: "", cwd: "", urls: "", extract: "text", selector: "", pattern: "", url: "", method: "GET", body: "", prompt: "", count: 1, forkOf: "" });
  const [busy, setBusy] = (0, import_react12.useState)(false);
  const [error, setError] = (0, import_react12.useState)("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    const spec = { type, title: f.title, runner: f.runner || "auto" };
    if (sessionId) spec.ownerSession = sessionId;
    if (type === "command") {
      spec.command = f.command;
      spec.cwd = f.cwd;
    }
    if (type === "scrape") {
      spec.urls = f.urls.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      spec.extract = f.extract;
      if (f.selector) spec.selector = f.selector;
      if (f.pattern) spec.pattern = f.pattern;
    }
    if (type === "http") {
      spec.url = f.url;
      spec.method = f.method;
      if (f.body) spec.body = f.body;
    }
    if (type === "agent") {
      spec.prompt = f.prompt;
      if (f.count > 1) spec.count = Number(f.count);
      if (f.forkOf.trim()) spec.forkOf = f.forkOf.trim();
    }
    setBusy(true);
    setError("");
    try {
      const r = await post("/tasks", spec);
      toast({ message: "Task " + (r.task && r.task.id || "") + " " + (r.task && r.task.status || "created") + ".", sessionId });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const ready = type === "command" ? f.command.trim() && commandsAllowed : type === "scrape" ? f.urls.trim() : type === "http" ? f.url.trim() : f.prompt.trim();
  return /* @__PURE__ */ import_react12.default.createElement("form", { className: "cdx-form", onSubmit: submit, "aria-label": "New task", "data-task-form": true }, /* @__PURE__ */ import_react12.default.createElement("span", { role: "group", "aria-label": "Task type", style: { display: "inline-flex", flexWrap: "wrap" } }, TYPES.map((tp) => /* @__PURE__ */ import_react12.default.createElement("button", { key: tp, type: "button", className: "cdx-chipbtn", "aria-pressed": type === tp, onClick: () => setType(tp) }, tp))), /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Title (optional)"), /* @__PURE__ */ import_react12.default.createElement("input", { className: "cdx-in", value: f.title, onChange: set("title") })), type === "command" ? commandsAllowed ? /* @__PURE__ */ import_react12.default.createElement(import_react12.default.Fragment, null, /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Shell command"), /* @__PURE__ */ import_react12.default.createElement("textarea", { className: "cdx-in", rows: 2, value: f.command, onChange: set("command"), placeholder: "runs on the selected runner" })), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-frow" }, /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Runner"), /* @__PURE__ */ import_react12.default.createElement("select", { className: "cdx-in", style: { width: "100%" }, value: f.runner, onChange: set("runner") }, /* @__PURE__ */ import_react12.default.createElement("option", { value: "" }, "auto (default)"), (runners || []).map((r) => /* @__PURE__ */ import_react12.default.createElement("option", { key: r.id, value: r.id }, r.id + " (" + r.kind + ")" + (r.enabled ? "" : " off"))))), /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Working directory"), /* @__PURE__ */ import_react12.default.createElement("input", { className: "cdx-in", value: f.cwd, onChange: set("cwd"), placeholder: "/" })))) : /* @__PURE__ */ import_react12.default.createElement(Note, { tone: "warn" }, "Shell command tasks are off by default. Turn them on in Settings, Conductor, Tasks.") : null, type === "scrape" ? /* @__PURE__ */ import_react12.default.createElement(import_react12.default.Fragment, null, /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "URLs (one per line)"), /* @__PURE__ */ import_react12.default.createElement("textarea", { className: "cdx-in", rows: 2, value: f.urls, onChange: set("urls") })), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-frow" }, /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field", style: { flex: "0 0 auto" } }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Extract"), /* @__PURE__ */ import_react12.default.createElement("select", { className: "cdx-in", value: f.extract, onChange: set("extract") }, ["text", "html", "json"].map((x) => /* @__PURE__ */ import_react12.default.createElement("option", { key: x, value: x }, x)))), /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Selector"), /* @__PURE__ */ import_react12.default.createElement("input", { className: "cdx-in", value: f.selector, onChange: set("selector"), placeholder: "h1, .price" })), /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Regex"), /* @__PURE__ */ import_react12.default.createElement("input", { className: "cdx-in", value: f.pattern, onChange: set("pattern") })))) : null, type === "http" ? /* @__PURE__ */ import_react12.default.createElement(import_react12.default.Fragment, null, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-frow" }, /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field", style: { flex: "0 0 auto" } }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Method"), /* @__PURE__ */ import_react12.default.createElement("select", { className: "cdx-in", value: f.method, onChange: set("method") }, ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((x) => /* @__PURE__ */ import_react12.default.createElement("option", { key: x, value: x }, x)))), /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "URL"), /* @__PURE__ */ import_react12.default.createElement("input", { className: "cdx-in", value: f.url, onChange: set("url"), placeholder: "https://" }))), f.method !== "GET" && f.method !== "HEAD" ? /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Body (JSON)"), /* @__PURE__ */ import_react12.default.createElement("textarea", { className: "cdx-in", rows: 2, value: f.body, onChange: set("body") })) : null) : null, type === "agent" ? /* @__PURE__ */ import_react12.default.createElement(import_react12.default.Fragment, null, /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Prompt"), /* @__PURE__ */ import_react12.default.createElement("textarea", { className: "cdx-in", rows: 3, value: f.prompt, onChange: set("prompt"), placeholder: "What the agent should do ({i} for fan-out)" })), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-frow" }, /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field", style: { flex: "0 0 64px" } }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Count"), /* @__PURE__ */ import_react12.default.createElement("input", { className: "cdx-in", type: "number", min: 1, max: 8, value: f.count, onChange: set("count") })), /* @__PURE__ */ import_react12.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "Fork from (optional)"), /* @__PURE__ */ import_react12.default.createElement("input", { className: "cdx-in", value: f.forkOf, onChange: set("forkOf"), placeholder: "chat id, prefix or title" })))) : null, error ? /* @__PURE__ */ import_react12.default.createElement(Note, { tone: "bad", role: "alert" }, error) : null, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react12.default.createElement("button", { type: "submit", className: "cdx-btn p s", disabled: busy || !ready }, busy ? "Creating\u2026" : "Create task"), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: onDone }, "Cancel")));
}
function TasksBlock({ data, sessionId }) {
  const settings = useSignal(settingsModel);
  const [scope, setScope] = (0, import_react12.useState)("mine");
  const [type, setType] = (0, import_react12.useState)("");
  const [open, setOpen] = (0, import_react12.useState)(null);
  const [form, setForm] = (0, import_react12.useState)(false);
  const all = data && data.tasks && data.tasks.rows || [];
  const rows = all.filter((t) => (scope === "all" || !sessionId || t.ownerSession === sessionId || t.agentSessionId === sessionId) && (!type || t.type === type));
  const anyRunning = rows.some((t) => t.status === "running");
  const now = useNow(1e3, anyRunning);
  const s = settings.data && settings.data.settings;
  const commandsAllowed = Boolean(s && s.tasks && s.tasks.allowCommandTasks);
  const cancel = async (t) => {
    try {
      await post("/tasks/" + enc2(t.id) + "/cancel", {});
      toast({ message: "Cancelled task " + t.id + ".", sessionId });
      refreshStatus();
    } catch (e) {
      toastError("Could not cancel the task.", e, sessionId);
    }
  };
  return /* @__PURE__ */ import_react12.default.createElement("div", null, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-sub" }, "Tasks", /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-spacer" }), sessionId ? /* @__PURE__ */ import_react12.default.createElement("span", { role: "group", "aria-label": "Which tasks", style: { display: "inline-flex" } }, /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-chipbtn", "aria-pressed": scope === "mine", onClick: () => setScope("mine") }, "This chat"), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-chipbtn", "aria-pressed": scope === "all", onClick: () => setScope("all") }, "All")) : null, /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s", "aria-expanded": form, onClick: () => setForm(!form) }, Icon.plus(12), "New task")), s && !commandsAllowed ? /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-help", style: { padding: "0 12px 6px" } }, "Shell command tasks are off by default (Settings, Conductor, Tasks). Scrape, HTTP and agent tasks work.") : null, form ? /* @__PURE__ */ import_react12.default.createElement(NewTaskForm, { runners: data && data.runners || [], sessionId: scope === "mine" ? sessionId : null, commandsAllowed, onDone: () => {
    setForm(false);
    refreshStatus();
  } }) : null, all.length ? /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-tools", style: { position: "static", minHeight: 30 } }, ["", ...TYPES].map((tp) => /* @__PURE__ */ import_react12.default.createElement("button", { key: tp || "all", type: "button", className: "cdx-chipbtn", "aria-pressed": type === tp, onClick: () => setType(tp) }, tp || "all"))) : null, !rows.length ? /* @__PURE__ */ import_react12.default.createElement(Empty, { title: "No background tasks" }, "Long running commands started by agents show live output here.") : /* @__PURE__ */ import_react12.default.createElement("ul", { className: "cdx-list", "aria-label": "Tasks" }, rows.slice(0, 40).map((t) => /* @__PURE__ */ import_react12.default.createElement("li", { key: t.id }, /* @__PURE__ */ import_react12.default.createElement(
    "div",
    {
      className: "cdx-row click" + (open === t.id ? " open" : ""),
      tabIndex: 0,
      "aria-expanded": open === t.id,
      "data-task": t.id,
      onClick: () => setOpen(open === t.id ? null : t.id),
      onKeyDown: (e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          setOpen(open === t.id ? null : t.id);
        }
      }
    },
    /* @__PURE__ */ import_react12.default.createElement("span", { className: STATUS_DOT[t.status] || "cdx-dot idle", role: "img", "aria-label": t.status }),
    /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-main" }, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react12.default.createElement("span", { title: t.title }, t.title || t.id)), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-chip" }, t.type), t.runner ? /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-chip" }, "@" + t.runner) : null, /* @__PURE__ */ import_react12.default.createElement("span", null, t.status === "running" ? "running" : t.status + " " + fmtAgo(t.finishedAt || t.createdAt)))),
    /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-side" }, /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-num", "aria-hidden": "true" }, duration(t, now)), t.status === "running" || t.status === "queued" ? /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s d", style: { marginLeft: 6 }, onClick: (e) => {
      e.stopPropagation();
      cancel(t);
    } }, "Cancel") : null),
    open === t.id ? /* @__PURE__ */ import_react12.default.createElement(TaskOutput, { t, sessionId }) : null
  )))));
}
function RunnersBlock({ sessionId }) {
  const [rows, setRows] = (0, import_react12.useState)(null);
  const [error, setError] = (0, import_react12.useState)(null);
  const [busy, setBusy] = (0, import_react12.useState)("");
  const load = (0, import_react12.useCallback)(() => getJson("/runners").then((j) => {
    setRows(j.rows || []);
    setError(null);
  }, setError), []);
  (0, import_react12.useEffect)(() => {
    load();
  }, [load]);
  const probe = async (id) => {
    setBusy(id);
    try {
      await post("/runners/probe", { runner: id });
    } catch (e) {
      toastError("Probe failed.", e, sessionId);
    }
    await load();
    setBusy("");
  };
  return /* @__PURE__ */ import_react12.default.createElement("div", null, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-sub" }, "Runners"), error ? /* @__PURE__ */ import_react12.default.createElement(SectionError, { what: "runners", error, onRetry: load }) : null, rows && !rows.length ? /* @__PURE__ */ import_react12.default.createElement(Empty, { title: "No runners" }, "Runners are declared in Settings, Conductor.") : null, rows && rows.length ? /* @__PURE__ */ import_react12.default.createElement("ul", { className: "cdx-list", "aria-label": "Runners" }, rows.map((r) => /* @__PURE__ */ import_react12.default.createElement("li", { key: r.id, className: "cdx-row" }, /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-dot " + (r.probe ? r.probe.ok ? "ok" : "bad" : "idle"), role: "img", "aria-label": r.probe ? r.probe.ok ? "Reachable" : "Unreachable" : "Not probed" }), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-main" }, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react12.default.createElement("span", null, r.id), /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-chip" }, r.kind), r.enabled === false ? /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-chip warn" }, "off") : null), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react12.default.createElement("span", null, r.probe ? r.probe.ok ? "reachable \xB7 " + r.probe.ms + " ms" : String(r.probe.detail || "unreachable").slice(0, 80) : r.label || "not probed yet"))), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s", disabled: busy === r.id, onClick: () => probe(r.id) }, busy === r.id ? "Probing\u2026" : "Probe")))) : null);
}
function ProvidersBlock() {
  const [rows, setRows] = (0, import_react12.useState)(null);
  const [error, setError] = (0, import_react12.useState)(null);
  const load = (0, import_react12.useCallback)((refresh) => getJson("/providers" + (refresh ? "?refresh=1" : "")).then((j) => {
    setRows(j.rows || []);
    setError(null);
  }, setError), []);
  (0, import_react12.useEffect)(() => {
    load();
  }, [load]);
  if (rows && !rows.length && !error) return null;
  return /* @__PURE__ */ import_react12.default.createElement("div", null, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-sub" }, "Providers", /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-spacer" }), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => load(true) }, "Refresh")), error ? /* @__PURE__ */ import_react12.default.createElement(SectionError, { what: "providers", error, onRetry: () => load(true) }) : null, rows ? /* @__PURE__ */ import_react12.default.createElement("ul", { className: "cdx-list", "aria-label": "Providers" }, rows.map((p) => /* @__PURE__ */ import_react12.default.createElement("li", { key: p.id, className: "cdx-row", style: { gridTemplateColumns: "18px minmax(0,1fr)" } }, /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-dot " + (p.ok ? "ok" : "bad"), role: "img", "aria-label": p.ok ? "Up" : "Down" }), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-main" }, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react12.default.createElement("span", null, p.label || p.id), /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-chip" }, p.kind)), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-meta", style: { whiteSpace: "normal" } }, /* @__PURE__ */ import_react12.default.createElement("span", null, [p.headline, p.queue ? "queue " + p.queue.running + " running, " + p.queue.pending + " pending" : "", p.detail].filter(Boolean).join(" \xB7 "))), p.kind === "http" && p.ok && p.fields ? /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-meta", style: { whiteSpace: "normal", flexWrap: "wrap" } }, Object.entries(p.fields).slice(0, 8).map(([k, v]) => /* @__PURE__ */ import_react12.default.createElement("span", { key: k }, k + ": " + String(v)))) : null)))) : null);
}
function runningNow(data) {
  const agents = (data && data.agents && data.agents.rows || []).filter((r) => r.running);
  const tasks = (data && data.tasks && data.tasks.rows || []).filter((t) => t.status === "running" || t.status === "queued");
  return { agents, tasks };
}
function OrchestrationSection({ sessionId, openSession }) {
  const status = useSignal(statusModel);
  const [all, setAll] = (0, import_react12.useState)(false);
  const [more, setMore] = (0, import_react12.useState)(false);
  (0, import_react12.useEffect)(() => {
    refreshStatus();
  }, []);
  if (status.status === "error" && !status.data) return /* @__PURE__ */ import_react12.default.createElement(SectionError, { what: "agents and tasks", error: status.error, onRetry: refreshStatus });
  if (!status.data) return /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-skel", "aria-busy": "true" });
  const now = runningNow(status.data);
  const nothing = !now.agents.length && !now.tasks.length;
  return /* @__PURE__ */ import_react12.default.createElement("div", null, all ? /* @__PURE__ */ import_react12.default.createElement(import_react12.default.Fragment, null, /* @__PURE__ */ import_react12.default.createElement(AgentsBlock, { data: status.data, sessionId, openSession }), /* @__PURE__ */ import_react12.default.createElement(TasksBlock, { data: status.data, sessionId })) : /* @__PURE__ */ import_react12.default.createElement(RunningNow, { data: status.data, now, sessionId, openSession, nothing }), more ? /* @__PURE__ */ import_react12.default.createElement(import_react12.default.Fragment, null, /* @__PURE__ */ import_react12.default.createElement(RunnersBlock, { sessionId }), /* @__PURE__ */ import_react12.default.createElement(ProvidersBlock, null)) : null, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-panelfoot" }, /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-link", "data-agents-all": true, "aria-expanded": all, onClick: () => setAll(!all) }, all ? "Running now only" : "Show all agents and tasks"), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-link", "data-agents-more": true, "aria-expanded": more, onClick: () => setMore(!more) }, more ? "Hide runners" : "More: runners and providers")));
}
function RunningNow({ data, now, sessionId, openSession, nothing }) {
  const [spawn, setSpawn] = (0, import_react12.useState)(false);
  const nowMs = useNow(1e3, now.tasks.some((t) => t.status === "running"));
  const cancelAgent = async (row) => {
    try {
      await post("/agents/" + enc2(row.sessionId) + "/cancel", {});
      toast({ message: "Asked " + (row.title || shortId(row.sessionId)) + " to stop.", sessionId });
      refreshStatus();
    } catch (e) {
      toastError("Could not stop the agent.", e, sessionId);
    }
  };
  const cancelTask = async (t) => {
    try {
      await post("/tasks/" + enc2(t.id) + "/cancel", {});
      toast({ message: "Cancelled task " + t.id + ".", sessionId });
      refreshStatus();
    } catch (e) {
      toastError("Could not cancel the task.", e, sessionId);
    }
  };
  return /* @__PURE__ */ import_react12.default.createElement("div", null, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-phead" }, /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-help" }, "Running now"), /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-spacer" }), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-link", "aria-expanded": spawn, onClick: () => setSpawn(!spawn) }, "Spawn agent")), spawn ? /* @__PURE__ */ import_react12.default.createElement(SpawnForm, { sessionId, onDone: () => {
    setSpawn(false);
    refreshStatus();
  } }) : null, nothing ? /* @__PURE__ */ import_react12.default.createElement(Empty, { title: "Nothing running" }, "Agents and background tasks appear here while they work.") : /* @__PURE__ */ import_react12.default.createElement("ul", { className: "cdx-list plain", "aria-label": "Running now" }, now.agents.map((row) => /* @__PURE__ */ import_react12.default.createElement("li", { key: row.sessionId, className: "cdx-row", "data-agent": row.sessionId }, /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-dot live pulse", role: "img", "aria-label": "Working" }), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-main" }, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react12.default.createElement("span", null, row.title || "(untitled)")), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react12.default.createElement("span", null, "agent \xB7 " + (fmtAgo(row.updatedAt) || "working")))), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-side" }, /* @__PURE__ */ import_react12.default.createElement(IconButton, { label: "Open " + (row.title || "chat"), onClick: () => openSession(row.sessionId) }, Icon.open(13)), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s d", onClick: () => cancelAgent(row) }, "Cancel")))), now.tasks.map((t) => /* @__PURE__ */ import_react12.default.createElement("li", { key: t.id, className: "cdx-row", "data-task": t.id }, /* @__PURE__ */ import_react12.default.createElement("span", { className: STATUS_DOT[t.status] || "cdx-dot idle", role: "img", "aria-label": t.status }), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-main" }, /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-title" }, /* @__PURE__ */ import_react12.default.createElement("span", null, t.title || t.id)), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-meta" }, /* @__PURE__ */ import_react12.default.createElement("span", null, t.type + " task \xB7 " + t.status))), /* @__PURE__ */ import_react12.default.createElement("div", { className: "cdx-side" }, /* @__PURE__ */ import_react12.default.createElement("span", { className: "cdx-num", "aria-hidden": "true" }, duration(t, nowMs)), /* @__PURE__ */ import_react12.default.createElement("button", { type: "button", className: "cdx-btn s d", onClick: () => cancelTask(t) }, "Cancel"))))));
}

// src/client/tab.jsx
var SUBTABS = ["context", "pins", "inbox", "history", "agents"];
var SUBTAB_TITLES = { context: "Context", pins: "Pins", inbox: "Inbox", history: "History", agents: "Agents" };
var ALIASES = { versions: "history", epochs: "history", activity: "history" };
var SECTION_IDS = [...SUBTABS, ...Object.keys(ALIASES)];
function subtabOf(section) {
  const id = ALIASES[section] || section;
  return SUBTABS.includes(id) ? id : null;
}
var LAST_KEY = "dsh-conductor:subtab";
function loadLast(sessionId) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) || "{}");
    return all && typeof all === "object" ? subtabOf(all[sessionId]) : null;
  } catch {
    return null;
  }
}
function saveLast(sessionId, id) {
  try {
    const all = JSON.parse(localStorage.getItem(LAST_KEY) || "{}") || {};
    delete all[sessionId];
    all[sessionId] = id;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k];
    localStorage.setItem(LAST_KEY, JSON.stringify(all));
  } catch {
  }
}
function inTextField(target) {
  return Boolean(target && target.closest && target.closest('input:not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable=""],[contenteditable=true]'));
}
function usePrefsBridge(store, tabId) {
  (0, import_react13.useEffect)(() => {
    if (!store || typeof store.getSnapshot !== "function") return void 0;
    const read = () => {
      try {
        const snap = store.getSnapshot();
        const blob = snap && snap.prefs && snap.prefs.pluginSettings && snap.prefs.pluginSettings[tabId];
        if (blob && typeof blob === "object" && blob !== prefs.get()) prefs.set(blob);
      } catch {
      }
    };
    read();
    return typeof store.subscribe === "function" ? store.subscribe(read) : void 0;
  }, [store, tabId]);
}
function ConductorTab({ sessionId, visible, store, tab, tabId, services }) {
  (0, import_react13.useEffect)(() => {
    ensureStyles();
  }, []);
  usePrefsBridge(store, tabId);
  if (!sessionId) {
    return /* @__PURE__ */ import_react13.default.createElement("div", { className: "cdx" }, /* @__PURE__ */ import_react13.default.createElement("div", { className: "cdx-center" }, "Open a chat to use Conductor."));
  }
  return /* @__PURE__ */ import_react13.default.createElement(ConductorSession, { key: sessionId, sessionId, visible, tab, services });
}
function SubTabs({ tabs, active, onSelect, counts, uid }) {
  const refs = (0, import_react13.useRef)({});
  const onKeyDown = (e) => {
    const i = tabs.indexOf(active);
    let next = null;
    if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
    else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    onSelect(next);
    const el = refs.current[next];
    if (el) el.focus();
  };
  return /* @__PURE__ */ import_react13.default.createElement("div", { className: "cdx-tabs", role: "tablist", "aria-label": "Conductor", onKeyDown }, tabs.map((id) => /* @__PURE__ */ import_react13.default.createElement(
    "button",
    {
      key: id,
      type: "button",
      role: "tab",
      id: uid + "-tab-" + id,
      "aria-controls": uid + "-panel-" + id,
      "aria-selected": active === id,
      tabIndex: active === id ? 0 : -1,
      "data-subtab": id,
      ref: (el) => {
        refs.current[id] = el;
      },
      onClick: () => onSelect(id)
    },
    SUBTAB_TITLES[id],
    counts[id] ? /* @__PURE__ */ import_react13.default.createElement("span", { className: "cdx-tcount" + (counts[id].live ? " live" : "") }, counts[id].n) : null
  )));
}
function ConductorSession({ sessionId, visible, tab, services }) {
  const model = (0, import_react13.useMemo)(() => sessionModel(sessionId), [sessionId]);
  const api = (0, import_react13.useMemo)(() => sessionApi(sessionId), [sessionId]);
  const snap = useSignal(model);
  const settings = useSignal(settingsModel);
  const status = useSignal(statusModel);
  const req = useSignal(requests);
  useSignal(prefs);
  useSignal(setupRerun);
  const view = snap.view;
  const [active, setActive] = (0, import_react13.useState)(() => loadLast(sessionId) || "context");
  const [filter, setFilter] = (0, import_react13.useState)(null);
  const [reset, setReset] = (0, import_react13.useState)(null);
  const [refreshing, setRefreshing] = (0, import_react13.useState)(false);
  const [cancelling, setCancelling] = (0, import_react13.useState)(false);
  const [dismissedResult, setDismissedResult] = (0, import_react13.useState)(null);
  const [panelOverride, setPanelOverride] = (0, import_react13.useState)(null);
  const lastUnread = (0, import_react13.useRef)(null);
  const panelRef = (0, import_react13.useRef)(null);
  const uid = (0, import_react13.useMemo)(() => "cdx" + Math.random().toString(36).slice(2, 8), []);
  (0, import_react13.useEffect)(() => {
    if (settings.status === "idle") refreshSettings();
  }, []);
  const busy = Boolean(reset) || Boolean(view && view.progress);
  const working = Boolean(view && (view.status === "running" || view.pending && (view.pending.steps || view.pending.afterTurn))) || runningCount() > 0;
  const autoPoll = pref("autoPoll") !== false;
  (0, import_react13.useEffect)(() => {
    if (!visible) return void 0;
    let stopped = false;
    let timer = null;
    const tick = async () => {
      await Promise.all([model.refresh().catch(() => null), moduleOn("orchestration") ? refreshStatus() : null]);
      if (stopped || !autoPoll) return;
      timer = setTimeout(tick, busy ? 1500 : working ? 4e3 : 15e3);
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [visible, model, busy, working, autoPoll]);
  const manualRefresh = (0, import_react13.useCallback)(async () => {
    setRefreshing(true);
    try {
      await Promise.all([model.refresh(), refreshStatus(), refreshSettings()]);
    } catch {
    } finally {
      setRefreshing(false);
    }
  }, [model]);
  const onReset = (0, import_react13.useCallback)(async (kind) => {
    const baseline = view && view.lastReset ? view.lastReset.id : null;
    setReset({ kind, at: Date.now(), baseline });
    setDismissedResult(null);
    try {
      await api.reset(kind);
      model.refresh().catch(() => {
      });
    } catch (e) {
      setReset(null);
      toast({ tone: "error", message: (kind === "new" ? "Could not start /new. " : kind === "clear" ? "Could not clear the context. " : "Could not compact. ") + errorText(e), sessionId });
    }
  }, [api, model, view, sessionId]);
  const onCancelReset = (0, import_react13.useCallback)(async () => {
    setCancelling(true);
    try {
      await api.cancelReset();
    } catch (e) {
      toast({ tone: "error", message: "Could not cancel. " + errorText(e), sessionId });
    } finally {
      setCancelling(false);
      model.refresh().catch(() => {
      });
    }
  }, [api, model, sessionId]);
  (0, import_react13.useEffect)(() => {
    if (!reset || !view) return;
    const last = view.lastReset;
    if (view.progress || !last || last.id === reset.baseline) return;
    setReset(null);
    if (last.ok) toast({ message: firstLine(last.text, 200) || "Context reset.", sessionId, ms: 6e3 });
    else if (isCancelled(last)) toast({ message: firstLine(last.text, 200), sessionId });
    else toast({ tone: "error", message: firstLine(last.text, 300) || "The reset failed. Your context is unchanged.", sessionId });
  }, [view, reset, sessionId]);
  const tabs = (0, import_react13.useMemo)(() => {
    const list = ["context"];
    if (moduleOn("pins")) list.push("pins");
    if (moduleOn("posts")) list.push("inbox");
    list.push("history");
    if (moduleOn("orchestration")) list.push("agents");
    return list;
  }, [settings]);
  const current = tabs.includes(active) ? active : "context";
  const select = (0, import_react13.useCallback)((id) => {
    setActive(id);
    saveLast(sessionId, id);
  }, [sessionId]);
  const reveal = (0, import_react13.useCallback)((section) => {
    const id = subtabOf(section);
    if (!id) return;
    setPanelOverride(null);
    select(id);
    const go = () => {
      const btn = document.getElementById(uid + "-tab-" + id);
      if (btn) btn.focus({ preventScroll: true });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
    else go();
  }, [select, uid]);
  (0, import_react13.useEffect)(() => {
    const hit = takeRequest(sessionId);
    if (hit) reveal(hit.section);
  }, [req, sessionId, reveal]);
  const metaSection = tab && tab.meta && tab.meta.section;
  const metaAt = tab && tab.meta && tab.meta.at;
  (0, import_react13.useEffect)(() => {
    if (metaSection) reveal(metaSection);
  }, [metaSection, metaAt]);
  (0, import_react13.useEffect)(() => {
    if (!view) return;
    const unread = view.unread || 0;
    if (lastUnread.current !== null && unread > lastUnread.current && pref("autoOpenInbox") && tabs.includes("inbox")) select("inbox");
    lastUnread.current = unread;
  }, [view && view.unread]);
  const onKeyDown = (e) => {
    if (e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && (e.key === "z" || e.key === "Z") && !inTextField(e.target)) {
      const t = latestUndo(sessionId);
      if (t) {
        e.preventDefault();
        runUndo(t.id);
      }
      return;
    }
    if (e.altKey && !mod && /^[1-5]$/.test(e.key)) {
      const id = tabs[Number(e.key) - 1];
      if (id) {
        e.preventDefault();
        reveal(id);
      }
    }
  };
  const openFile = (0, import_react13.useCallback)((path) => {
    if (!path) return;
    try {
      if (services.sidebar && typeof services.sidebar.openFile === "function") {
        services.sidebar.openFile({ sessionId }, path);
        return;
      }
    } catch (e) {
      console.warn("[dsh-conductor] openFile failed", e);
    }
    toast({ tone: "error", message: "Could not open " + path + " in the sidebar.", sessionId });
  }, [services, sessionId]);
  const openSession = (0, import_react13.useCallback)((id) => {
    const ws = services.workspace && services.workspace();
    try {
      if (ws && typeof ws.openSession === "function") {
        ws.openSession(id);
        return;
      }
    } catch (e) {
      console.warn("[dsh-conductor] openSession failed", e);
    }
    toast({ tone: "error", message: "This DSH build cannot switch chats from a plugin. Chat id: " + id, sessionId });
  }, [services, sessionId]);
  const guide = setupNeeded();
  const error = snap.error;
  if (!view) {
    return /* @__PURE__ */ import_react13.default.createElement("div", { className: "cdx" }, /* @__PURE__ */ import_react13.default.createElement("div", { className: "cdx-head" }, snap.status === "error" ? null : /* @__PURE__ */ import_react13.default.createElement(Skeleton, { rows: 2 })), /* @__PURE__ */ import_react13.default.createElement("div", { className: "cdx-body" }, snap.status === "error" ? /* @__PURE__ */ import_react13.default.createElement(OfflineNote, { error, onRetry: manualRefresh }) : /* @__PURE__ */ import_react13.default.createElement(Skeleton, { rows: 4 })), /* @__PURE__ */ import_react13.default.createElement(LiveRegions, null));
  }
  const now = status.data ? runningNow(status.data) : { agents: [], tasks: [] };
  const counts = {
    pins: (view.pins || []).length ? { n: view.pins.length } : null,
    inbox: view.unread ? { n: view.unread, live: true } : null,
    agents: now.agents.length + now.tasks.length ? { n: now.agents.length + now.tasks.length, live: true } : null
  };
  const panelProps = { sessionId, view, api, model, openFile, openSession };
  if (guide) {
    return /* @__PURE__ */ import_react13.default.createElement("div", { className: "cdx", onKeyDown, "data-conductor-root": true }, /* @__PURE__ */ import_react13.default.createElement("header", { className: "cdx-head" }, /* @__PURE__ */ import_react13.default.createElement(Meter, { view, onFilter: (f) => setFilter(f) }), /* @__PURE__ */ import_react13.default.createElement(
      ResetBar,
      {
        view,
        fetchedAt: snap.viewAt,
        reset,
        onReset,
        onCancel: onCancelReset,
        cancelling,
        onRefresh: manualRefresh,
        refreshing,
        resultDismissed: view.lastReset && dismissedResult === view.lastReset.id,
        onDismissResult: () => setDismissedResult(view.lastReset && view.lastReset.id),
        openFile,
        onSetup: null
      }
    )), /* @__PURE__ */ import_react13.default.createElement("div", { className: "cdx-body", "data-panel": "setup" }, /* @__PURE__ */ import_react13.default.createElement(SetupGuide, { settings: settings.data, onDone: () => select("context") }), /* @__PURE__ */ import_react13.default.createElement("div", { style: { height: 56 }, "aria-hidden": "true" })), /* @__PURE__ */ import_react13.default.createElement(ToastHost, { sessionId }), /* @__PURE__ */ import_react13.default.createElement(LiveRegions, null));
  }
  const panel = () => {
    switch (current) {
      case "pins":
        return /* @__PURE__ */ import_react13.default.createElement(PinsSection, { ...panelProps });
      case "inbox":
        return /* @__PURE__ */ import_react13.default.createElement(InboxSection, { ...panelProps });
      case "history":
        return /* @__PURE__ */ import_react13.default.createElement(HistoryPanel, { ...panelProps, putDraft: services.putDraft ? services.putDraft() : null });
      case "agents":
        return /* @__PURE__ */ import_react13.default.createElement(OrchestrationSection, { sessionId, openSession });
      default:
        return /* @__PURE__ */ import_react13.default.createElement(ContextPanel, { ...panelProps, filter, onFilter: setFilter, busyAgent: view.status === "running" });
    }
  };
  return /* @__PURE__ */ import_react13.default.createElement("div", { className: "cdx", onKeyDown, "data-conductor-root": true }, /* @__PURE__ */ import_react13.default.createElement("header", { className: "cdx-head" }, /* @__PURE__ */ import_react13.default.createElement(Meter, { view, onFilter: (f) => {
    setPanelOverride(null);
    setFilter(f);
    reveal("context");
  }, onAutomation: () => setPanelOverride("automation") }), /* @__PURE__ */ import_react13.default.createElement(
    ResetBar,
    {
      view,
      fetchedAt: snap.viewAt,
      reset,
      onReset,
      onCancel: onCancelReset,
      cancelling,
      onRefresh: manualRefresh,
      refreshing,
      resultDismissed: view.lastReset && dismissedResult === view.lastReset.id,
      onDismissResult: () => setDismissedResult(view.lastReset && view.lastReset.id),
      openFile,
      onSetup: guide ? null : () => setupRerun.set(true),
      onAutomation: () => setPanelOverride("automation")
    }
  ), view.pending && view.pending.afterTurn ? /* @__PURE__ */ import_react13.default.createElement("div", { className: "cdx-help", style: { marginTop: 8 } }, "/" + view.pending.afterTurn + " runs when the current turn ends.") : null), error ? /* @__PURE__ */ import_react13.default.createElement(OfflineNote, { error, onRetry: manualRefresh, compact: true }) : null, panelOverride === "automation" ? /* @__PURE__ */ import_react13.default.createElement("div", { className: "cdx-body", "data-panel": "automation" }, /* @__PURE__ */ import_react13.default.createElement(AutomationPanel, { sessionId, view, api, model, onBack: () => setPanelOverride(null) }), /* @__PURE__ */ import_react13.default.createElement("div", { style: { height: 56 }, "aria-hidden": "true" })) : null, panelOverride === "automation" ? null : /* @__PURE__ */ import_react13.default.createElement(SubTabs, { tabs, active: current, onSelect: (id) => {
    setPanelOverride(null);
    select(id);
  }, counts, uid }), panelOverride === "automation" ? null : /* @__PURE__ */ import_react13.default.createElement(
    "div",
    {
      className: "cdx-body",
      role: "tabpanel",
      id: uid + "-panel-" + current,
      "aria-labelledby": uid + "-tab-" + current,
      "data-panel": current,
      ref: panelRef,
      tabIndex: -1
    },
    panel(),
    /* @__PURE__ */ import_react13.default.createElement("div", { style: { height: 56 }, "aria-hidden": "true" })
  ), /* @__PURE__ */ import_react13.default.createElement(ToastHost, { sessionId }), /* @__PURE__ */ import_react13.default.createElement(LiveRegions, null));
}
function OfflineNote({ error, onRetry, compact }) {
  if (error && error.offline) {
    return /* @__PURE__ */ import_react13.default.createElement(Note, { tone: "warn", role: "alert", actions: /* @__PURE__ */ import_react13.default.createElement("button", { type: "button", className: "cdx-btn s", onClick: onRetry }, "Retry now") }, "Conductor can\u2019t reach its service. It will keep retrying.", compact ? " The numbers above may be stale." : "");
  }
  if (error && error.status === 404) {
    return /* @__PURE__ */ import_react13.default.createElement(Note, { tone: "warn", actions: /* @__PURE__ */ import_react13.default.createElement("button", { type: "button", className: "cdx-btn s", onClick: onRetry }, "Retry") }, "This chat is not loaded on the server yet. Send a message or reopen the chat, then retry.");
  }
  return /* @__PURE__ */ import_react13.default.createElement(Note, { tone: "bad", role: "alert", actions: /* @__PURE__ */ import_react13.default.createElement("button", { type: "button", className: "cdx-btn s", onClick: onRetry }, "Retry") }, "Couldn\u2019t load Conductor. " + errorText(error));
}

// src/client/star.jsx
var import_react14 = __toESM(require("react"), 1);
function PinStar({ messageId, sessionId }) {
  (0, import_react14.useEffect)(() => {
    ensureStyles();
  }, []);
  const model = (0, import_react14.useMemo)(() => sessionId ? sessionModel(sessionId) : null, [sessionId]);
  if (!model || !messageId) return null;
  return /* @__PURE__ */ import_react14.default.createElement(PinStarInner, { messageId, sessionId, model });
}
function PinStarInner({ messageId, sessionId, model }) {
  const snap = useSignal(model);
  const [pending, setPending] = (0, import_react14.useState)(false);
  const [failure, setFailure] = (0, import_react14.useState)("");
  (0, import_react14.useEffect)(() => {
    model.ensure(6e4);
  }, [model]);
  const pins = snap.view && snap.view.pins || [];
  const pin = pins.find((p) => p.messageId === messageId);
  const pinned = Boolean(pin);
  const label = pinned ? "Unpin" : "Pin to context";
  const toggle = async () => {
    if (pending) return;
    setPending(true);
    setFailure("");
    const api = sessionApi(sessionId);
    try {
      if (pinned) {
        await api.unpin(pin.id);
        announce("Unpinned. " + fmtTokens(pin.tokens || 0) + " tokens leave the context at the next reset.");
      } else {
        const r = await api.pin(messageId);
        announce("Pinned. " + fmtTokens(r.pin && r.pin.tokens || 0) + " tokens added to context.");
      }
    } catch (e) {
      setFailure(e && e.code === "limit" ? "Pin limit reached. Unpin one to add another." : (pinned ? "Could not unpin: " : "Could not pin: ") + errorText(e));
    } finally {
      setPending(false);
      model.refresh().catch(() => {
      });
    }
  };
  return /* @__PURE__ */ import_react14.default.createElement("span", { className: "cdx-star", "data-conductor-star": true }, /* @__PURE__ */ import_react14.default.createElement(
    "button",
    {
      type: "button",
      "aria-label": label,
      title: label,
      "aria-pressed": pinned,
      disabled: pending,
      onPointerEnter: () => {
        model.ensure(15e3);
      },
      onFocus: () => {
        model.ensure(15e3);
      },
      onClick: toggle
    },
    Icon.star(15, pinned)
  ), failure ? /* @__PURE__ */ import_react14.default.createElement("span", { className: "cdx-star-msg", role: "status" }, failure) : null);
}

// src/client/settings.jsx
var import_react15 = __toESM(require("react"), 1);
var transparent = (c) => !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
function useFlushStickyBar(ref, ready) {
  (0, import_react15.useLayoutEffect)(() => {
    const bar = ref.current;
    if (!bar || typeof window === "undefined" || typeof getComputedStyle !== "function") return void 0;
    let raf = 0;
    const measure = () => {
      raf = 0;
      let el = bar.parentElement;
      let scroller = null;
      while (el && el !== document.documentElement) {
        const cs = getComputedStyle(el);
        if (!scroller && /(auto|scroll|overlay)/.test(cs.overflowY)) scroller = el;
        if (scroller) break;
        el = el.parentElement;
      }
      const pad = scroller ? parseFloat(getComputedStyle(scroller).paddingBottom) || 0 : 0;
      bar.style.bottom = pad ? -pad + "px" : "0px";
      bar.style.paddingBottom = Math.max(10, pad) + "px";
      bar.style.marginBottom = pad ? -pad + "px" : "";
      let bg = "";
      for (let p = bar.parentElement; p; p = p.parentElement) {
        const c = getComputedStyle(p).backgroundColor;
        if (!transparent(c)) {
          bg = c;
          break;
        }
      }
      if (bg) bar.style.backgroundColor = bg;
    };
    const schedule2 = () => {
      if (!raf) raf = (window.requestAnimationFrame || setTimeout)(measure);
    };
    measure();
    window.addEventListener("resize", schedule2);
    let mo = null;
    if (typeof MutationObserver === "function" && document.body) {
      mo = new MutationObserver(schedule2);
      mo.observe(document.body, { attributes: true });
      mo.observe(document.documentElement, { attributes: true });
    }
    return () => {
      window.removeEventListener("resize", schedule2);
      if (mo) mo.disconnect();
      if (raf && window.cancelAnimationFrame) window.cancelAnimationFrame(raf);
    };
  }, [ref, ready]);
}
function Row({ title, desc, children }) {
  return /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-srow" }, /* @__PURE__ */ import_react15.default.createElement("div", null, /* @__PURE__ */ import_react15.default.createElement("div", { className: "t" }, title), desc ? /* @__PURE__ */ import_react15.default.createElement("div", { className: "d" }, desc) : null), /* @__PURE__ */ import_react15.default.createElement("div", null, children));
}
function Group({ title, children, note }) {
  return /* @__PURE__ */ import_react15.default.createElement("section", { className: "cdx-sgroup" }, /* @__PURE__ */ import_react15.default.createElement("h4", null, title), note || null, children);
}
function SettingsSection() {
  (0, import_react15.useEffect)(() => {
    ensureStyles();
  }, []);
  const [data, setData] = (0, import_react15.useState)(null);
  const [form, setForm] = (0, import_react15.useState)(null);
  const [busy, setBusy] = (0, import_react15.useState)(false);
  const [status, setStatus] = (0, import_react15.useState)(null);
  const [loadError, setLoadError] = (0, import_react15.useState)(null);
  const [secret, setSecret] = (0, import_react15.useState)("");
  const barRef = (0, import_react15.useRef)(null);
  useFlushStickyBar(barRef, Boolean(form));
  const load = (0, import_react15.useCallback)(async () => {
    try {
      const j = await getJson("/settings");
      setData(j);
      setForm(JSON.parse(JSON.stringify(j.settings)));
      setLoadError(null);
      settingsModel.set({ status: "ready", data: j, error: null });
    } catch (e) {
      setLoadError(e);
    }
  }, []);
  (0, import_react15.useEffect)(() => {
    load();
  }, [load]);
  if (loadError && !form) {
    return /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-set" }, /* @__PURE__ */ import_react15.default.createElement(Note, { tone: "bad", role: "alert", actions: /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn s", onClick: load }, "Retry") }, "Couldn\u2019t load the Conductor settings. The host half must be mounted (restart dsh-web after installing). " + errorText(loadError)));
  }
  if (!form) return /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-set" }, /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-skel", "aria-busy": "true" }), /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-skel" }));
  const set = (path, value) => setForm((f) => setPath(f, path, value));
  const get = (path) => getPath(form, path);
  const sw = (path, label) => /* @__PURE__ */ import_react15.default.createElement(Switch, { checked: Boolean(get(path)), label, onChange: (v) => set(path, v) });
  const num = (path, opts = {}) => /* @__PURE__ */ import_react15.default.createElement(
    "input",
    {
      className: "cdx-in n",
      type: "number",
      min: opts.min,
      max: opts.max,
      step: opts.step,
      "aria-label": opts.label,
      value: opts.scale ? Math.round((Number(get(path)) || 0) / opts.scale * 10) / 10 : get(path) ?? "",
      onChange: (e) => {
        const n = Number(e.target.value);
        set(path, Number.isFinite(n) ? opts.scale ? Math.round(n * opts.scale) : n : 0);
      }
    }
  );
  const text = (path, opts = {}) => /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", "aria-label": opts.label, placeholder: opts.placeholder, value: String(get(path) ?? ""), onChange: (e) => set(path, e.target.value) });
  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await mutate("PUT", "/settings", buildSettingsPatch(form));
      setStatus({ tone: "ok", text: "Settings saved. They apply at once; tool switches reach new turns." });
      await load();
    } catch (e) {
      setStatus({ tone: "bad", text: "Save failed: " + errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const saveSecret = async (clear) => {
    setBusy(true);
    try {
      await post("/secret", clear ? { clear: true } : { secret: secret.trim() });
      setSecret("");
      setStatus({ tone: "ok", text: clear ? "Machine API secret cleared: the machine API is closed." : "Machine API secret saved." });
      await load();
    } catch (e) {
      setStatus({ tone: "bad", text: "Secret not saved: " + errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const runners = form.runners || [];
  const providers = form.providers || [];
  const api = form.api || {};
  const armed = Boolean(api.secretConfigured || data && data.envSecretPresent);
  const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:3080";
  const curl = "curl -sS -X POST " + origin + API + `/remote/post \\
  -H "content-type: application/json" \\
  -H "x-conductor-secret: $CONDUCTOR_SECRET" \\
  -d '{"to":"<chat id or title>","text":"build finished","kind":"report"}'`;
  return /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-set", "data-conductor-settings": true }, /* @__PURE__ */ import_react15.default.createElement(Note, null, "Conductor: context tools (/new, /clear, /drop, pins, versions), silent posts between chats, and the agents and tasks orchestrator. Everything below is deployment state, saved on the host."), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "General" }, /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Plugin enabled", desc: "Master switch for the host half." }, sw(["enabled"], "Plugin enabled")), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Mirror tasks into Background Tasks", desc: "Show Conductor tasks in the DSH jobs list too." }, sw(["mirrorJobs"], "Mirror tasks")), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Require the harness cookie on UI calls", desc: "Keep on unless a proxy strips cookies." }, sw(["requireHarnessCookie"], "Require harness cookie")), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Trusted hosts", desc: "Comma separated host names allowed to call the UI API." }, /* @__PURE__ */ import_react15.default.createElement(
    "input",
    {
      className: "cdx-in",
      "aria-label": "Trusted hosts",
      value: (form.trustedHosts || []).join(", "),
      onChange: (e) => set(["trustedHosts"], e.target.value.split(",").map((s) => s.trim()).filter(Boolean))
    }
  ))), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Modules" }, MODULES.map(([k, t, d]) => /* @__PURE__ */ import_react15.default.createElement(Row, { key: k, title: t, desc: d }, sw(["modules", k], t)))), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Model tools" }, TOOLS.map(([k, t, d]) => /* @__PURE__ */ import_react15.default.createElement(Row, { key: k, title: t, desc: d }, sw(["tools", k], t)))), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "The model may", note: /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-help", style: { margin: "0 0 4px" } }, "What the assistant may do through its tools. You can always do all of it yourself.") }, MODEL_MAY.map(([k, t]) => /* @__PURE__ */ import_react15.default.createElement(Row, { key: k, title: t }, sw(["modelMay", k], t)))), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Context" }, /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Handoff folder", desc: "Where /new writes its handoff files. Empty: the plugin state folder." }, text(["handoffDir"], { label: "Handoff folder", placeholder: "default" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Reset timeout", desc: "Give up on /new, /clear or /force-compact after this many minutes (1 to 60)." }, num(["resetTimeoutMs"], { min: 1, max: 60, scale: 6e4, label: "Reset timeout in minutes" }))), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Automatic level", note: /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-help", style: { margin: "0 0 4px" } }, "For every chat; a chat can set its own in Conductor, Automation.") }, /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Level (percent of the model window)", desc: "0 keeps DSH's own default (about 80%). Otherwise 10 to 95." }, num(["autoCompact", "percent"], { min: 0, max: 95, label: "Automatic level percent" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "At the level", desc: "Compact summarises in place; Hand off starts a fresh context from a handoff." }, /* @__PURE__ */ import_react15.default.createElement("select", { className: "cdx-in", style: { width: 160 }, "aria-label": "Action at the level", value: get(["autoCompact", "action"]) || "compact", onChange: (e) => set(["autoCompact", "action"], e.target.value) }, /* @__PURE__ */ import_react15.default.createElement("option", { value: "compact" }, "Compact"), /* @__PURE__ */ import_react15.default.createElement("option", { value: "handoff" }, "Hand off"))), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Heads-up before the level", desc: "The assistant is told once, shortly before." }, sw(["autoCompact", "nudge"], "Heads-up before the level"))), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Recovery" }, RECOVERY_FIELDS.map(([k, t, d, kind]) => /* @__PURE__ */ import_react15.default.createElement(Row, { key: k, title: t, desc: d }, kind === "bool" ? sw(["recovery", k], t) : kind === "sec" ? num(["recovery", k], { min: 0, scale: 1e3, step: 0.1, label: t }) : kind === "num" ? num(["recovery", k], { min: 0, label: t }) : kind === "overflow" ? /* @__PURE__ */ import_react15.default.createElement("select", { className: "cdx-in", style: { width: 160 }, "aria-label": t, value: get(["recovery", "overflow"]) || "handoff", onChange: (e) => set(["recovery", "overflow"], e.target.value) }, /* @__PURE__ */ import_react15.default.createElement("option", { value: "handoff" }, "Hand off"), /* @__PURE__ */ import_react15.default.createElement("option", { value: "stop" }, "Stop")) : text(["recovery", k], { label: t, placeholder: "default" }))), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Fallback model", desc: "Provider and model id as in DSH's model list, for example deepseek and deepseek-chat. Empty: no fallback." }, /* @__PURE__ */ import_react15.default.createElement("span", { className: "cdx-btnrow", style: { flexWrap: "nowrap" } }, /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", style: { width: 110 }, "aria-label": "Fallback provider", placeholder: "provider", value: String(get(["recovery", "fallbackProvider"]) || ""), onChange: (e) => set(["recovery", "fallbackProvider"], e.target.value) }), /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", style: { width: 140 }, "aria-label": "Fallback model", placeholder: "model", value: String(get(["recovery", "fallbackModel"]) || ""), onChange: (e) => set(["recovery", "fallbackModel"], e.target.value) })))), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Handoff template", note: /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-help", style: { margin: "0 0 4px" } }, "The sections every /new handoff fills in. Empty: the default eight sections. A chat can set its own.") }, /* @__PURE__ */ import_react15.default.createElement("textarea", { className: "cdx-in", rows: 8, "aria-label": "Handoff template for all chats", value: String(get(["handoffTemplate"]) || ""), placeholder: DEFAULT_HANDOFF_TEMPLATE, onChange: (e) => set(["handoffTemplate"], e.target.value) }), /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-btnrow", style: { marginTop: 6 } }, /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => set(["handoffTemplate"], DEFAULT_HANDOFF_TEMPLATE) }, "Start from the default"), /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn s g", onClick: () => set(["handoffTemplate"], "") }, "Use the default"))), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Silent posts" }, /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Maximum characters inline", desc: "Longer posts are saved to a file and the message carries the first part and the path." }, num(["posts", "maxChars"], { min: 500, max: 1e5, label: "Maximum characters" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Show a row in the target chat", desc: "A command style row so the person reading that chat sees the post." }, sw(["posts", "chatRow"], "Show a row in the target chat"))), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Agents" }, /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Default preset", desc: "Empty: the deployment default." }, text(["agents", "defaultPreset"], { label: "Default preset" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Default working directory", desc: "Empty: the server default." }, text(["agents", "defaultCwd"], { label: "Default working directory" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Spawn fan-out cap" }, num(["agents", "spawnMax"], { min: 1, label: "Spawn cap" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Catalog rows" }, num(["agents", "catalogMax"], { min: 1, label: "Catalog rows" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Transcript messages per read" }, num(["agents", "transcriptMax"], { min: 5, label: "Transcript messages" }))), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Tasks" }, /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Allow shell command tasks", desc: "Off by default: anything that can create a task could run commands on this host." }, sw(["tasks", "allowCommandTasks"], "Allow shell command tasks")), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Allow remote runners", desc: "Off by default: ssh and http runners execute on other machines." }, sw(["tasks", "allowRemoteRunners"], "Allow remote runners")), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Concurrent tasks" }, num(["tasks", "maxConcurrent"], { min: 1, label: "Concurrent tasks" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Finished tasks kept" }, num(["tasks", "historyKeep"], { min: 1, label: "Finished tasks kept" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Command timeout (seconds)" }, num(["tasks", "commandTimeoutMs"], { min: 1, scale: 1e3, label: "Command timeout" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Scrape timeout (seconds)" }, num(["tasks", "scrapeTimeoutMs"], { min: 1, scale: 1e3, label: "Scrape timeout" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "HTTP timeout (seconds)" }, num(["tasks", "httpTimeoutMs"], { min: 1, scale: 1e3, label: "HTTP timeout" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Scrape URL limit" }, num(["tasks", "scrapeMaxUrls"], { min: 1, max: 64, label: "Scrape URL limit" })), /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Default runner" }, text(["tasks", "defaultRunner"], { label: "Default runner" }))), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Runners" }, runners.map((r, i) => /* @__PURE__ */ import_react15.default.createElement("div", { key: i, className: "cdx-card" }, /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-frow" }, /* @__PURE__ */ import_react15.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react15.default.createElement("span", null, "Id"), /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", value: r.id || "", onChange: (e) => set(["runners", i, "id"], e.target.value) })), /* @__PURE__ */ import_react15.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react15.default.createElement("span", null, "Label"), /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", value: r.label || "", onChange: (e) => set(["runners", i, "label"], e.target.value) })), /* @__PURE__ */ import_react15.default.createElement("label", { className: "cdx-field", style: { flex: "0 0 auto" } }, /* @__PURE__ */ import_react15.default.createElement("span", null, "Kind"), /* @__PURE__ */ import_react15.default.createElement("select", { className: "cdx-in", value: r.kind, onChange: (e) => set(["runners", i, "kind"], e.target.value) }, ["local", "ssh", "http"].map((k) => /* @__PURE__ */ import_react15.default.createElement("option", { key: k, value: k }, k))))), r.kind === "ssh" ? /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-frow", style: { marginTop: 6 } }, /* @__PURE__ */ import_react15.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react15.default.createElement("span", null, "ssh target"), /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", value: r.ssh && r.ssh.target || "", onChange: (e) => set(["runners", i, "ssh", "target"], e.target.value), placeholder: "alias or user@host" })), /* @__PURE__ */ import_react15.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react15.default.createElement("span", null, "ssh binary"), /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", value: r.ssh && r.ssh.bin || "", onChange: (e) => set(["runners", i, "ssh", "bin"], e.target.value), placeholder: "ssh" }))) : null, r.kind === "http" ? /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-frow", style: { marginTop: 6 } }, /* @__PURE__ */ import_react15.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react15.default.createElement("span", null, "URL"), /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", value: r.http && r.http.url || "", onChange: (e) => set(["runners", i, "http", "url"], e.target.value), placeholder: "https://other-host/dsh-conductor/api/remote/run" })), /* @__PURE__ */ import_react15.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react15.default.createElement("span", null, "Secret env var"), /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", value: r.http && r.http.secretEnv || "", onChange: (e) => set(["runners", i, "http", "secretEnv"], e.target.value) }))) : null, /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-btnrow", style: { marginTop: 8 } }, /* @__PURE__ */ import_react15.default.createElement(Switch, { checked: r.enabled !== false, label: "Runner " + r.id + " enabled", onChange: (v) => set(["runners", i, "enabled"], v) }), /* @__PURE__ */ import_react15.default.createElement("span", { className: "cdx-help" }, "enabled"), /* @__PURE__ */ import_react15.default.createElement("span", { className: "cdx-spacer" }), /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn s d", onClick: () => set(["runners"], runners.filter((_, j) => j !== i)) }, "Remove runner")))), /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn s", onClick: () => set(["runners"], [...runners, { id: "runner-" + (runners.length + 1), label: "", kind: "local", enabled: true }]) }, "Add runner")), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Providers" }, providers.map((p, i) => /* @__PURE__ */ import_react15.default.createElement("div", { key: i, className: "cdx-card" }, /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-frow" }, /* @__PURE__ */ import_react15.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react15.default.createElement("span", null, "Id"), /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", value: p.id || "", onChange: (e) => set(["providers", i, "id"], e.target.value) })), /* @__PURE__ */ import_react15.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react15.default.createElement("span", null, "Label"), /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", value: p.label || "", onChange: (e) => set(["providers", i, "label"], e.target.value) })), /* @__PURE__ */ import_react15.default.createElement("label", { className: "cdx-field", style: { flex: "0 0 auto" } }, /* @__PURE__ */ import_react15.default.createElement("span", null, "Kind"), /* @__PURE__ */ import_react15.default.createElement("select", { className: "cdx-in", value: p.kind, onChange: (e) => set(["providers", i, "kind"], e.target.value) }, ["http", "hpc"].map((k) => /* @__PURE__ */ import_react15.default.createElement("option", { key: k, value: k }, k))))), /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-frow", style: { marginTop: 6 } }, /* @__PURE__ */ import_react15.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react15.default.createElement("span", null, "URL"), /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", value: p.url || "", onChange: (e) => set(["providers", i, "url"], e.target.value), placeholder: p.kind === "hpc" ? "http://host/dsh-hpc/api" : "https://status-endpoint/json" })), p.kind === "http" ? /* @__PURE__ */ import_react15.default.createElement("label", { className: "cdx-field" }, /* @__PURE__ */ import_react15.default.createElement("span", null, "Secret env var"), /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", value: p.secretEnv || "", onChange: (e) => set(["providers", i, "secretEnv"], e.target.value) })) : null), /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-btnrow", style: { marginTop: 8 } }, /* @__PURE__ */ import_react15.default.createElement(Switch, { checked: p.enabled !== false, label: "Provider " + p.id + " enabled", onChange: (v) => set(["providers", i, "enabled"], v) }), /* @__PURE__ */ import_react15.default.createElement("span", { className: "cdx-help" }, "enabled"), /* @__PURE__ */ import_react15.default.createElement("span", { className: "cdx-spacer" }), /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn s d", onClick: () => set(["providers"], providers.filter((_, j) => j !== i)) }, "Remove provider")))), /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn s", onClick: () => set(["providers"], [...providers, { id: "provider-" + (providers.length + 1), label: "", kind: "http", url: "", enabled: true, pollSeconds: 60 }]) }, "Add provider")), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Machine API" }, /* @__PURE__ */ import_react15.default.createElement(Note, { tone: armed ? "ok" : "warn" }, armed ? "The machine API is armed. Anything that can reach this host and present the secret can post to chats, prompt them, spawn agents and run tasks." : "The machine API fails closed: no secret is configured. Set one here or set DSH_CONDUCTOR_SECRET on the host."), /* @__PURE__ */ import_react15.default.createElement(Row, { title: api.secretConfigured ? "Rotate the secret" : "Set a secret", desc: api.secretFingerprint ? "Stored fingerprint " + api.secretFingerprint + (data && data.envSecretPresent ? " (an environment secret is present and wins)" : "") : "At least 16 characters." }, /* @__PURE__ */ import_react15.default.createElement("span", { className: "cdx-btnrow" }, /* @__PURE__ */ import_react15.default.createElement("input", { className: "cdx-in", type: "password", autoComplete: "new-password", "aria-label": "Machine API secret", style: { width: 180 }, value: secret, onChange: (e) => setSecret(e.target.value) }), /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn s", disabled: busy || secret.trim().length < 16, onClick: () => saveSecret(false) }, "Save secret"), api.secretConfigured ? /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn s d", disabled: busy, onClick: () => saveSecret(true) }, "Clear") : null)), /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-help", style: { margin: "8px 0 4px" } }, "Post silently into a chat from a script:"), /* @__PURE__ */ import_react15.default.createElement("pre", { className: "cdx-pre log" }, curl), /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn s g", style: { marginTop: 6 }, onClick: () => copyText(curl) }, "Copy example")), /* @__PURE__ */ import_react15.default.createElement(Group, { title: "Setup guide" }, /* @__PURE__ */ import_react15.default.createElement(Row, { title: "Run setup guide again", desc: "Opens the short guided setup in the Conductor tab of the next chat you open it in." }, /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn s", "data-rerun-setup": true, onClick: () => {
    setupRerun.set(true);
    setStatus({ tone: "ok", text: "The setup guide opens in the Conductor tab." });
  } }, "Run setup guide"))), /* @__PURE__ */ import_react15.default.createElement("div", { className: "cdx-sbar", ref: barRef }, /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn p", disabled: busy, onClick: save, "data-save-settings": true }, busy ? "Saving\u2026" : "Save settings"), /* @__PURE__ */ import_react15.default.createElement("button", { type: "button", className: "cdx-btn", disabled: busy, onClick: load }, "Revert"), status ? /* @__PURE__ */ import_react15.default.createElement("span", { role: status.tone === "bad" ? "alert" : "status", style: { fontSize: 12, color: status.tone === "bad" ? "var(--bad)" : "var(--ok)" } }, status.text) : null));
}

// src/client/index.jsx
var name = "dsh-conductor";
var inject = ["betterSidebar", "slots", "locale"];
var warn = (message, error) => console.warn("[dsh-conductor] " + message + (error ? ": " + String(error && error.message || error) : ""));
var SECTION_COMMANDS = [
  { name: "conductor", section: "context", label: "Conductor", description: "Open the Conductor tab: context, pins, inbox and agents" },
  { name: "pins", section: "pins", label: "Pins", description: "Show pinned messages in Conductor" },
  { name: "inbox", section: "inbox", label: "Inbox", description: "Show silent messages from other chats" },
  { name: "versions", section: "history", label: "Versions", description: "Show edited messages and their versions in History" }
];
function effect(ctx, fn, label) {
  try {
    if (typeof ctx.effect === "function") return ctx.effect(fn, label);
    return fn();
  } catch (error) {
    warn(label + " failed", error);
    return void 0;
  }
}
function tabDescriptor(sidebar, services) {
  return {
    id: TAB_ID,
    title: "Conductor",
    description: "Context meter, drops, pins, inbox, resets and agents for this chat.",
    order: 85,
    single: true,
    icon: (size) => Icon.conductor(size || 16),
    badge: (_ctx, scope) => badgeFor(scope && scope.sessionId),
    component: (props) => /* @__PURE__ */ import_react16.default.createElement(
      ConductorTab,
      {
        sessionId: props && props.scope && typeof props.scope.sessionId === "string" ? props.scope.sessionId : null,
        visible: Boolean(props && props.visible),
        store: props && props.store,
        tab: props && props.tab,
        tabId: TAB_ID,
        services
      }
    ),
    settings: {
      pluginToggles: [
        { key: "autoPoll", type: "switch", title: "Poll while visible", desc: "Refresh Conductor every few seconds while the tab is open." },
        { key: "undoSeconds", type: "number", min: 5, max: 30, unit: "s", title: "Undo window", desc: "How long Undo stays available after a drop, unpin or dismiss." },
        { key: "warnPercent", type: "number", min: 50, max: 95, unit: "%", title: "Context warning", desc: "Show a hint when the context is fuller than this." },
        { key: "inboxBadge", type: "switch", title: "Count unread inbox in the tab badge", desc: "Turn off to count only running agents and tasks." },
        { key: "autoOpenInbox", type: "switch", title: "Open Inbox when something new arrives", desc: "Expands the section, never steals focus." }
      ]
    }
  };
}
function openSection(sidebar, sessionId, section) {
  if (!SECTION_IDS.includes(section)) section = "context";
  requestSection(sessionId, section);
  if (!sidebar || typeof sidebar.openTab !== "function") {
    warn("Better Sidebar is unavailable; cannot open the Conductor tab");
    return false;
  }
  try {
    sidebar.openTab({ type: TAB_ID, target: "right", reveal: true, meta: { section, at: Date.now() } }, sessionId ? { sessionId } : void 0);
    return true;
  } catch (error) {
    warn("could not open the Conductor tab", error);
    return false;
  }
}
function apply(ctx) {
  const sidebar = ctx.betterSidebar && typeof ctx.betterSidebar.registerTab === "function" ? ctx.betterSidebar : null;
  let workspace = null;
  let sessionsService = null;
  const putDraft = (sessionId, text) => {
    try {
      const binding = sessionsService && typeof sessionsService.binding === "function" ? sessionsService.binding(sessionId) : null;
      const bctx = binding && binding.ctx;
      const conversation = bctx && typeof bctx.get === "function" ? bctx.get("conversation") : null;
      const input = conversation && conversation.input && typeof conversation.input.for === "function" ? conversation.input.for(bctx) : null;
      if (!input || typeof input.setDraft !== "function") return false;
      input.setDraft(String(text));
      if (typeof input.focus === "function") input.focus();
      return true;
    } catch (error) {
      warn("could not put the prompt back in the input box", error);
      return false;
    }
  };
  const services = { sidebar, workspace: () => workspace, putDraft: () => sessionsService ? putDraft : null };
  const openFromChat = (sessionId, section) => openSection(sidebar, sessionId, section);
  if (!sidebar) {
    console.error("[dsh-conductor] ctx.betterSidebar.registerTab is unavailable; the Conductor tab is not registered");
  } else {
    effect(ctx, () => sidebar.registerTab(tabDescriptor(sidebar, services)), "dsh-conductor: register the Conductor tab");
  }
  const slots = ctx.slots && typeof ctx.slots.inject === "function" && typeof ctx.slots.register === "function" ? ctx.slots : null;
  if (!slots) warn("ctx.slots unavailable; the settings section and the message star are not registered");
  if (slots) {
    effect(ctx, () => slots.inject("conversation.chat.assistant-actions", () => slots.register({
      name: "conversation.chat.assistant-actions",
      id: "dsh-conductor-pin",
      order: 20,
      inject: (sessionId) => ({ sessionId })
    }, function ConductorPinAction(props) {
      useSignal(settingsModel);
      if (!moduleOn("pins")) return null;
      return /* @__PURE__ */ import_react16.default.createElement(PinStar, { messageId: props && props.messageId, sessionId: props && props.sessionId });
    })), "dsh-conductor: message star");
    effect(ctx, () => slots.inject("conversation.chat.assistant-actions", () => slots.register({
      name: "conversation.chat.assistant-actions",
      id: "dsh-conductor-version",
      order: 21,
      inject: (sessionId) => ({ sessionId })
    }, function ConductorVersionAction(props) {
      return /* @__PURE__ */ import_react16.default.createElement(AssistantVersionAction, { messageId: props && props.messageId, sessionId: props && props.sessionId, openSection: openFromChat });
    })), "dsh-conductor: version marker");
    registerChatRenderers(ctx, slots, effect, warn, openFromChat);
  }
  if (slots) {
    effect(ctx, () => slots.inject("settings.section", () => slots.register({
      name: "settings.section",
      id: "dsh-conductor",
      order: 96,
      label: () => "Conductor",
      inject: () => ({})
    }, function ConductorSettingsSlot() {
      import_react16.default.useEffect(() => {
        ensureStyles();
      }, []);
      return /* @__PURE__ */ import_react16.default.createElement(SettingsSection, null);
    })), "dsh-conductor: settings section");
  }
  if (typeof ctx.inject !== "function") {
    warn("ctx.inject unavailable; slash command actions and chat navigation are off");
    return;
  }
  try {
    ctx.inject(["uiWorkspace"], (scope) => {
      try {
        workspace = scope.get ? scope.get("uiWorkspace") : scope.uiWorkspace;
      } catch (error) {
        warn("uiWorkspace unavailable", error);
      }
      effect(scope, () => () => {
        workspace = null;
      }, "dsh-conductor: workspace handle");
    });
  } catch (error) {
    warn("uiWorkspace injection failed", error);
  }
  try {
    ctx.inject(["sessions"], (scope) => {
      try {
        sessionsService = scope.get ? scope.get("sessions") : scope.sessions;
      } catch (error) {
        warn("sessions unavailable", error);
      }
      effect(scope, () => () => {
        sessionsService = null;
      }, "dsh-conductor: sessions handle");
    });
  } catch (error) {
    warn("sessions injection failed", error);
  }
  try {
    ctx.inject(["uiConversation"], (scope) => {
      let ui = null;
      try {
        ui = scope.get ? scope.get("uiConversation") : scope.uiConversation;
      } catch (error) {
        warn("uiConversation unavailable", error);
      }
      registerGhostDefinition(ui, scope, effect, warn);
    });
  } catch (error) {
    warn("uiConversation injection failed", error);
  }
  try {
    ctx.inject(["commandUi"], (scope) => {
      let commands = null;
      try {
        commands = scope.get ? scope.get("commandUi") : scope.commandUi;
      } catch (error) {
        warn("commandUi unavailable", error);
      }
      if (!commands) return;
      const canOpen = () => Boolean(sidebar);
      if (typeof commands.decorate === "function") {
        effect(scope, () => commands.decorate({
          name: "drop",
          available: () => canOpen() && moduleOn("context"),
          ui: { kind: "action", run: (session) => {
            openSection(sidebar, session && session.sessionId, "context");
          } }
        }), "dsh-conductor: /drop opens the Context inspector");
      }
      if (typeof commands.register === "function") {
        for (const c of SECTION_COMMANDS) {
          effect(scope, () => commands.register({
            name: c.name,
            label: () => c.label,
            description: () => c.description,
            available: () => canOpen() && (c.section === "pins" ? moduleOn("pins") : c.section === "inbox" ? moduleOn("posts") : c.name === "versions" ? moduleOn("versions") : true),
            ui: { kind: "action", run: (session) => {
              openSection(sidebar, session && session.sessionId, c.section);
            } }
          }), "dsh-conductor: /" + c.name);
        }
      }
    });
  } catch (error) {
    warn("commandUi injection failed", error);
  }
  refreshSettings();
}
return module.exports; } });
//# sourceMappingURL=client.js.map
