# dsh-conductor: orchestration reference (agents, tasks, runners, providers, machine API)

**Agent swarm + task orchestration for DeepSeek Harness (DSH).**

A plugin that adds an **Orchestrate** tab to dsh-better-sidebar: like the built-in Background Tasks view, but broader:

- **Agents**: create, list, prompt, **fork** (split a conversation), fan-out and cancel agent chats, with a **chat-style** transcript drawer. Sessions address all of it through 14 `orch_*` tools.
- **Tasks**: tracked, status-updated work of four kinds: `command` (shell on any runner), `scrape` (deterministic multi-URL extraction, no model in the loop), `http` (endpoint calls), `agent` (a spawned chat whose answer is the task output).
- **Runners**: where commands execute: this host, ssh targets, or remote **tool servers** (any other host running this plugin). Explicit selection or the configured default.
- **Providers**: external integrations rendered as status cards, including the **dsh-hpc** plugin's grant view and any JSON status endpoint.
- **Remote API**: a secret-protected machine API: prompt chats, spawn agents, create tasks, and serve the tool-server contract so OTHER hosts can run work here.

Everything is **settings-driven**: runners, providers, presets, limits and the API secret live in Settings → Orchestrator (or the cordis config row). Nothing is hardcoded: no hosts, no commands, no credentials in the code.

---

## Contents

- [Install](#install)
- [The tab](#the-tab)
- [The agent tools](#the-agent-tools)
- [Task types](#task-types)
- [Runners: where work executes](#runners-where-work-executes)
- [Providers: integrations](#providers-integrations)
- [The machine API](#the-machine-api)
- [Settings reference](#settings-reference)
- [Security model](#security-model)
- [Kill switches](#kill-switches)
- [Development](#development)

## Install

Requires DSH >= 0.1.1-rc.1, Node >= 22.5, the `web` profile, and dsh-better-sidebar (the tab host).

```sh
dsh plugin --profile web add dsh-conductor   # from npm, once published
# or, from a checkout:
cd ~/.dsh/profiles/web
pnpm add link:/path/to/dsh-conductor
```

Then append `dsh-conductor` to `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json`, run `pnpm install`, and **restart dsh-web** (the client half mounts live after a browser refresh; the host half: tools, settings namespace, API route: needs the restart). Full steps are in cordis.patch.yml.

## The tab

Open the sidebar **+** menu → **Orchestrate**. Five sections:

| Section | What it shows / does |
|---|---|
| **agents** | every chat (live + cold) with title, running state, recency; quick **prompt**, **stop**, **chat** drawer (transcript + send box + fork + cancel); **+ new agent** spawn form with fan-out |
| **tasks** | every task with status, runner, live output (auto-polling while running), cancel; **+ new task** form for all four types |
| **runners** | execution targets with health probes |
| **providers** | integration cards: an hpc provider shows the grant headline, queue, collector health and staged proposals |
| **api** | machine-API secret management + ready-made curl examples + the tool-server contract |

A badge on the tab counts active work (running agents + running tasks).

## The agent tools

Sessions get these tools (registered through the standard `ctx.tools` seam: they behave like any core tool):

| tool | what it does |
|---|---|
| `orch_status` | one-screen overview: agents, tasks by status, runners, providers |
| `orch_agents_list` | list chats (live/cold, titles, running flags), with search |
| `orch_agent_status` | one chat: running state + last user/assistant text |
| `orch_agent_prompt` | deliver a message into a chat (id, unique prefix, or exact title); cold chats resume |
| `orch_agent_spawn` | create chat(s), optionally with a first prompt; `count` fans out with `{i}` interpolation: **how you split work across agents** |
| `orch_agent_fork` | **split a conversation**: fork a chat's completed-turn history into a new session, then prompt the fork |
| `orch_agent_cancel` | cancel a chat's active turn (queued work is kept) |
| `orch_task_create` | create + run a task (see below) |
| `orch_task_list` / `orch_task_status` / `orch_task_output` | list / inspect / read tasks |
| `orch_task_cancel` | cancel a task (kills the runner process or cancels the agent turn) |
| `orch_runners` | runner inventory + health probes |
| `orch_providers` | provider status cards (e.g. the HPC grant) |

## Task types

| type | spec fields | output |
|---|---|---|
| `command` | `command`, `cwd`, `runner`, `timeoutMs` | stdout + stderr, capped |
| `scrape` | `urls[]`, `extract` (text/html/json), `selector` (tag/.class/#id/[attr]), `attribute`, `pattern` (regex) | JSON rows: per-URL status + extracted data |
| `http` | `url`, `method`, `body`, `headers`, `expectStatus`, `timeoutMs` | response body, capped |
| `agent` | `prompt`, `count` (fan-out), `forkOf` (split an existing chat), `promptExisting` (drive an existing chat), `preset`, `cwd` | the chat itself: live status while it works, the assistant answer when it settles |

All tasks: global concurrency cap with queueing, cancellation, durable history with pruning, and an audit event log. Tasks also mirror (best-effort) into `ctx.jobs` so they appear in the built-in Background Tasks surface.

**Live output**: command tasks stream stdout/stderr into the task record as it arrives (the tab's output panel and `orch_task_output` show progress while the command runs: not just the final result); scrape tasks log per-URL progress lines (`[2/5] https://… -> 200`) before the structured JSON replaces them at settlement.

After mounting (restart), verify the host with `bash scripts/verify-host.sh [port] [secret]`: health, dashboard shape, the trust fence, the CSRF gate, and (with the secret) a machine probe round trip.

## Runners: where work executes

Declared in Settings: never in code:

- **local**: spawn on this host (`bash -lc <command>`, argv only, scrubbed env: no SSH_AUTH_SOCK, no inherited secrets)
- **ssh**: `ssh <target> -- <command>`; target, binary, connect timeout and extra args are operator config; the command is one argv element on this side
- **http**: a remote **tool server** speaking this plugin's contract: `POST {url} {kind, spec, timeoutMs}` → `{ok, status, output, detail}`. Any host running dsh-conductor serves it at `/dsh-conductor/api/remote/run`: so your boxes can run work for each other. The auth token is read from an env var **at call time** (`secretEnv`), never stored.

Selection: explicit `runner` id, else the configured default, else round-robin across enabled runners.

## Providers: integrations

- **hpc**: speaks the dsh-hpc route shape: reads `{url}/health` and `{url}/state` and surfaces the grant headline, balance, queue, collector health and staged/armed proposals. Point `url` at wherever dsh-hpc is mounted (default path `/dsh-hpc/api` on that host).
- **http**: any JSON status endpoint; `ok`/`health`/`status`/`headline` keys are highlighted when present, everything else renders as fields. Optional `secretEnv` for a bearer token read at call time.

Add your own control planes (pods, orchestrators, dashboards) as http providers; add your remote boxes as ssh or http runners. The plugin has **zero** knowledge of any specific host.

## The machine API

Protected by a secret (`DSH_CONDUCTOR_SECRET` env or Settings), constant-time compared, rate-limited per IP, **failing closed** when no secret is configured. Present it as `x-conductor-secret: <secret>` or `Authorization: Bearer <secret>`.

```sh
# prompt any chat (id, unique prefix, or exact title): cold chats resume
curl -sS -X POST http://127.0.0.1:3080/dsh-conductor/api/remote/prompt \\
  -H "content-type: application/json" \\
  -H "x-conductor-secret: $DSH_CONDUCTOR_SECRET" \\
  -d '{"chat":"Research","message":"status report?"}'

# spawn an agent
curl -sS -X POST http://127.0.0.1:3080/dsh-conductor/api/remote/agents/create \\
  -H "content-type: application/json" \\
  -H "x-conductor-secret: $DSH_CONDUCTOR_SECRET" \\
  -d '{"title":"nightly-research","prompt":"summarize todays papers","count":3}'

# run work on this host from anywhere (the tool-server contract)
curl -sS -X POST http://127.0.0.1:3080/dsh-conductor/api/remote/run \\
  -H "content-type: application/json" \\
  -H "x-conductor-secret: $DSH_CONDUCTOR_SECRET" \\
  -d '{"kind":"command","spec":{"command":"uptime"},"timeoutMs":30000}'
# -> {"ok":true,"status":"completed","output":"..."}
```

Reads (`/status`, `/agents`, `/tasks`, `/providers`, `/runners`, `/settings`) also answer to the secret. Browser reads are trust-fenced (loopback + Host authority); browser mutations additionally require the same-origin CSRF header set and the harness session cookie (see Security).

## Settings reference

Where the values live depends on the DSH line (lib/dual-settings.js picks it by capability): on DSH 0.1.5 they are the registered namespace `dsh-conductor` in `settings.yaml`; on DSH 0.2.x they are the `dsh-conductor` row of the profile's `cordis.patch.yml` (every field live except `stateDir`), imported once from `settings.yaml.imported` while the row is still empty. `api.secret` is a secret field and is redacted on every read.

Everything lives under the `dsh-conductor` settings namespace (Settings → Orchestrator) or the cordis config row. Highlights:

| key | default | meaning |
|---|---|---|
| `enabled` | true | master switch |
| `api.secret` / env `DSH_CONDUCTOR_SECRET` |: | machine API secret (env wins; never echoed back) |
| `api.rateLimitPerMinute` | 60 | per-IP machine call budget |
| `agents.spawnMax` | 8 | fan-out cap per spawn |
| `agents.defaultPreset` / `agents.defaultCwd` |: | defaults for new chats |
| `tasks.maxConcurrent` | 4 | engine-wide live task cap |
| `tasks.defaultRunner` | local | runner for unqualified tasks |
| `tasks.allowCommandTasks` | true | can command tasks run at all |
| `tasks.allowRemoteRunners` | true | may tasks leave this host |
| `tasks.historyKeep` | 400 | finished tasks kept |
| `mirrorJobs` | true | mirror tasks into ctx.jobs (Background Tasks tab) |
| `runners[]` | local only | execution targets: see above |
| `providers[]` |: | integrations: see above |
| `trustedHosts[]` |: | extra Host authorities for the public edge |

## Security model

Two caller classes, two gates (full detail in docs/DESIGN.md):

- **Browser** (tab + settings UI): loopback peer + trust fence (Host authority, no cross-site) on reads; adds same-origin `sec-fetch-site`/Origin, JSON content-type, the plugin's `X-Requested-With` header, and the harness session cookie presence on mutations. No GET ever mutates.
- **Machine** (curl / cron / other boxes): the operator secret, constant-time compared, per-IP rate-limited, with a tighter wrong-secret budget. Fails closed with no secret.
- Commands run with a **scrubbed environment** (PATH/HOME/LANG only) and argv-only spawning. SSH credentials are the operator's ssh config; http tokens are env vars read at call time. Secrets never appear in settings reads, logs, or the task store.

## Kill switches

```sh
# disable without uninstalling (needs a dsh-web restart):
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-conductor
  disabled: true

# runtime, no restart:
DSH_CONDUCTOR_DISABLE=1   # in the dsh-web environment
```

## Development

```sh
npm run check   # node --check every file
npm run build   # bundle src/client.jsx -> lib/client.js (esbuild; resolved
                # from a sibling plugin on a dsh host, or ESBUILD_MAIN)
npm test        # 47 host-half tests + client render test
```

The client test needs jsdom/react: resolved from a sibling plugin on a dsh host, or it skips cleanly in a bare checkout.

## Status

0.1.0: prototype, used daily on one deployment. MIT license. Issues and PRs welcome.
