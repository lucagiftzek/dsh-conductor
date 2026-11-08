# dsh-conductor: design notes

## What this plugin is

A DSH host-side plugin + browser module that turns a DSH deployment into a small
orchestration surface: a catalog of agent chats, a durable task engine, remote
execution targets, external integration cards, and a machine API. One code path
per action: the model tools, the sidebar tab, the settings section and the
machine API all drive the same engine.

## Shape

    lib/index.js    apply(): settings namespace, engine boot, route, tools
    lib/core.js     config/defaults/limits + sanitization (one path for both
                    the cordis config row and the settings namespace)
    lib/security.js the two gates (browser, machine) + rate limiters
    lib/store.js    tasks.json (atomic tmp+rename) + events.jsonl (bounded)
    lib/runners.js  local/ssh/http execution, argv-only, scrubbed env
    lib/agents.js   the agent facade over ctx.agents + sessionController +
                    sessionQuery (all public seams, all optional)
    lib/tasks.js    the task engine + deterministic extraction helpers
    lib/providers.js hpc (dsh-hpc route shape) + generic http adapters
    lib/tools.js    14 orch_* tool definitions
    lib/api.js      the route: reads trust-fenced, mutations gated
    src/client.jsx  the Orchestrate tab + the Settings section (bundled)

## Non-negotiables

1. **No static @deepseek-ai/ imports in the host half.** They drift between
   releases and a failed static import is a boot-killing SyntaxError on this
   profile (learned the hard way: 794 restarts on 2026-09-08). Everything
   optional resolves through ctx.get() at apply() time; defineTool and
   schemastery resolve defensively with multiple seeds and degrade to honest
   'unavailable' states.
2. **No hardcoded infrastructure.** No hosts, no ssh targets, no endpoints, no
   presets, no commands, no credentials. The DEFAULTS describe only the
   plugin's own behaviour (limits, timings, the state dir under DSH_HOME) and
   the 'local' runner, which names THIS host. Runners, providers, presets,
   trusted hosts and the API secret are operator state.
3. **One engine.** Every mutation: from a tool call, the tab, the settings UI
   or the machine API: goes through TaskEngine/agents facade methods that
   validate, persist and audit the same way. There is no second code path.
4. **Secrets never travel.** The machine secret is read from env or the
   settings store, compared in constant time, never echoed (settings reads
   return a fingerprint), never logged. http-runner/provider auth tokens are
   env var NAMES in config, read at call time.

## The two gates

    BROWSER (tab + settings, same-origin fetch)
      reads:    loopback peer  +  Host-authority trust fence  (the harness's
                own isTrustedApiRequest behaviour, vendored like dsh-hpc does)
      mutations: + sec-fetch-site: same-origin, Origin present, JSON
                content-type, X-Requested-With: dsh-conductor, harness
                session cookie present. No GET ever mutates; no POST reads.

    MACHINE (curl / cron / another box)
      the operator secret (x-conductor-secret or Bearer), constant-time,
      per-IP sliding-minute rate limit, a tighter wrong-secret budget,
      fail-closed with no secret configured.

A browser request that also carries a valid secret takes the machine path
(strictly stronger evidence).

## Task lifecycle

    queued -> running -> completed | failed | cancelled
                   \-> interrupted   (boot reaping: anything still running
                                     when dsh-web died is honestly labelled)

- creation validates the full type-specific spec BEFORE anything is registered;
  a validation failure leaves no trace
- a global concurrency cap queues overflow; the queue drains on every settle
- every transition appends to events.jsonl and flushes tasks.json atomically
- agent tasks settle by polling the agent facade: done = agent idle AND an
  assistant message exists (5-minute grace for empty answers); the task output
  IS the chat (chat-style, updated live)
- ctx.jobs mirroring is best-effort and self-disables if the composition has
  no job controller serving unscoped work

## Runner safety

- local: spawn('bash', ['-lc', command]): argv only, never an interpolated
  shell string; env is scrubbed to PATH/HOME/LANG
- ssh: spawn(bin, [options..., target, '--', command]): the command is ONE
  argv element on this side; the remote shell interpreting it is the
  operator's own declared machine
- http: the documented tool-server contract; secrets via env at call time
- tasks.allowCommandTasks / tasks.allowRemoteRunners are hard switches

## What is intentionally NOT here

- No scheduling/cron (DSH already has dsh-schedule; the machine API is the
  seam a cron would call)
- No LLM calls of our own: the plugin drives the harness's agents, it never
  talks to a model directly (deterministic scrapes stay deterministic)
- No CSS engine for scrape selectors: one simple compound token, predictable,
  dependency-free

## Test coverage

47 host-half tests (config sanitization, both gates, the store, runner
selection + real local execution, extraction helpers, the engine lifecycle
including cancel/concurrency/restart-reaping/agent-settlement, the agents
facade against a fake controller, providers against a fake fetch, all 14 tool
definitions compiled + executed, and the full API surface including auth
budgets) plus a jsdom render test that boots the built client bundle the way
the browser loader does and exercises the tab, the chat drawer and the
settings section.
