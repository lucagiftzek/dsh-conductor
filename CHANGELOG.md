# Changelog

## 0.2.0 (2026-11-08)

### Added
- Checkpoints and rewind: a checkpoint per prompt and `/checkpoint <name>`; `/rewind` takes the conversation, the files the agent edited, or both back to any checkpoint, or continues from it in a new chat (`--branch`); file conflicts are detected, `/rewind undo` reverses a file restore. Shell-made changes are not tracked.
- Automatic level: per chat and global percentage of the model window at which the chat compacts or hands off to a fresh context by itself, with one heads-up to the model before it; `/auto level`, `/auto pause`.
- Scheduled `/new`: daily at a time or every N turns (`/auto new`).
- Recovery, replacing dsh-continue: resumes after rate limits, provider errors, cut-off answers and restarts, honours Retry-After, stops at once on quota and credential errors with a ghost, hands off on context overflow, optional fallback model per chat; `/recovery`. The migration removes @weibaohui/dsh-continue and keeps its resume text.
- Relay: final answers of a worker chat arrive in a coordinator as ghosts (`/relay`).
- `/recall`: search a chat's earlier epochs; also a `chat` tool action.
- Custom handoff template, global and per chat; running subagents and background jobs are listed in every handoff.
- First-run setup guide in the Conductor tab; Automation panel; checkpoints and search in History; rewind dividers in the chat.
- Edited messages and ghosts render in the main chat (v2 markers, Ghost labels), with a visible fallback notice and a contract test against the installed DSH.

### Changed
- Settings writes merge nested groups with the stored values.
- Ghosts have their own source kind and no command row by default.

## 0.1.0 (2026-11-08)

First release. dsh-conductor merges dsh-force-compact and dsh-orchestrator and adds context and message management.

### Added
- `/new [focus]`: resets the chat in place to a handoff written by the model from the full conversation (one cache-friendly call; map-reduce fallback past the model window). Same chat id, title, pin and sidebar position. The handoff is saved as a file and the replaced span is archived verbatim.
- `/clear`: empties the model context with a short placeholder and no model call. Pins are kept.
- `/context`, `/drop`, `/undrop`: inspect the context by size and take tool outputs, messages or whole assistant steps out of it, with placeholders the model can see and the originals saved to files.
- Pins (`/pin`, `/unpin`, star button): kept verbatim through every `/new`, `/clear` and compaction.
- Message versions: edit an answer (user or model), every version kept with a diff, restore any version.
- Silent messages between chats (`/post`, `chats post`, `scripts/dsh-post`, `POST /remote/post`): shown in the target chat and read by its model on the next turn, without waking it.
- Three model tools (`chat`, `chats`, `tasks`) replacing the 14 `orch_*` tools, which stay available behind `tools.legacy`.
- Conductor tab for dsh-better-sidebar: context meter and inspector, pins, inbox, epochs, versions, agents and tasks, activity.
- `scripts/migrate-profile.mjs`: switches a profile from dsh-force-compact and dsh-orchestrator, carrying their configuration over (dry run by default, backups, formatting preserved).
- `legacyRoute`: optionally serve the API under `/dsh-orchestrator/api` for existing scripts.
- Lab test harness: isolated DSH instance, scripted mock model, HTTP probe, end-to-end suite with a reload check of every touched chat.

### Changed (from dsh-orchestrator)
- Shell command tasks and remote runners are off by default (`tasks.allowCommandTasks`, `tasks.allowRemoteRunners`).
- Secret header `x-conductor-secret` (the old `x-orchestrator-secret` and `DSH_ORCHESTRATOR_SECRET` are still accepted).

### Kept (from dsh-force-compact)
- `/force-compact [--pointer] [focus]`, the verbatim archive of every compaction in `~/.dsh/compact-archive`, and the chunked fallback when a summary overflows the model window.
