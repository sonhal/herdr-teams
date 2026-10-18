# herdr-teams — Plan

> Status: **draft for review**. Nothing is implemented yet. Sections marked
> **(assumed)** are defaults chosen while open questions are pending; change
> them freely.

## 1. Goal

A [herdr](https://github.com/ogulcancelik/herdr) plugin that lets one agent (the
**lead**) run a team of **persistent, named teammates**. Teammates coordinate
through a **shared task board** and talk through **peer inboxes**. Every
teammate is a real herdr pane running a real coding-agent CLI.

**herdr only.** Panes, tabs, workspaces, worktrees, agent start-up, prompting
and state detection all come from herdr. We ship **no** tmux, Zellij, iTerm2,
WezTerm or Windows Terminal adapters. "Separate OS windows" from pi-teams become
herdr **tabs** or **workspaces**.

### Feature scope (from the brief)

| Area | Feature |
|---|---|
| Team | Spawn named teammates, each with its own model and thinking level |
| Team | Show teammates as herdr panes (split, tab, or their own workspace) |
| Team | Predefined teams in `teams.yaml`; save a running team as a reusable template |
| Team | Agent definitions as markdown files |
| Team | **New:** git worktrees per teammate or per task, managed by the lead |
| Coordination | Persistent shared task board with statuses (and dependencies) |
| Coordination | Plan mode: a teammate writes a plan first; the team decides whether it waits for the lead's approval |
| Coordination | Shell quality-gate hooks that run when a task completes |
| Communication | Direct messages, broadcast to the team, reports to the lead |
| Communication | Idle teammates wake up when work arrives (push from herdr events, not polling) |
| Supervision | **New:** live state from herdr, time in state, stall / needs-input advisories |
| Supervision | **New:** peek, steer, urgent messages, interrupt a turn while keeping context, release a task, kill |

## 2. Research summary

### 2.1 What herdr gives us (v0.9.5, read from `docs/preview/website/...`)

- **Plugin = manifest + commands.** A plugin is a directory with
  `herdr-plugin.toml`. It declares `[[build]]`, `[[startup]]`, `[[actions]]`,
  `[[events]]`, `[[panes]]` and `[[link_handlers]]`. Each entry is an argv
  command in any language. *"The entire herdr CLI is the plugin API"*:
  commands call back through `$HERDR_BIN_PATH`.
- **Injected env:** `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_PLUGIN_ID`,
  `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`,
  `HERDR_PLUGIN_CONTEXT_JSON`, and the `HERDR_WORKSPACE_ID` / `TAB_ID` /
  `PANE_ID` of the current context. Event hooks also get `HERDR_PLUGIN_EVENT`
  and `HERDR_PLUGIN_EVENT_JSON`.
- **Hookable events** (`PLUGIN_HOOK_EVENT_KINDS` in `src/api/schema/events.rs`)
  include **`pane.agent_status_changed`**, `pane.agent_detected`,
  `pane.exited`, `pane.closed`, `pane.moved` and `worktree.created` /
  `worktree.removed`. This is how idle teammates get woken without polling.
- **No storage API, no supervised daemons.** Startup hooks are one-shot. The
  plugin owns its files.
- **Layout:** `workspace create`, `tab create` and
  `pane split --direction right|down --cwd --env K=V --no-focus`. Each returns
  JSON with the new IDs.
- **Worktrees:** `herdr worktree create --cwd <repo> --branch <b> --base <ref>
  --label <l> --no-focus` creates the git worktree **and** opens it as a herdr
  workspace grouped with the repo. `worktree remove` runs
  `git worktree remove` and never deletes branches.
- **Agents:** `herdr agent start <name> --kind <kind> --pane <id> -- <args>`.
  It supports `claude`, `codex`, `pi`, `opencode`, `gemini`, `copilot`,
  `cursor`, `amp`, `droid` and others (about 24 kinds). It returns only once
  the agent is ready. Names follow `[a-z][a-z0-9_-]{0,31}`.
- **Driving agents:** `agent prompt <name> "<text>" [--wait --until idle]`,
  `agent wait`, `agent read --source recent-unwrapped --lines N` and
  `agent send-keys <name> esc`. `agent prompt` refuses to type into an agent
  that is `blocked` (returns `agent_blocked`), which is a useful safety
  property.
- **State model:** `idle`, `working`, `blocked`, `done` and `unknown`. herdr
  detects it from the screen or from integrations, and it rolls up to the
  sidebar.
- **Display:** `pane report-metadata --source herdr-teams --title ...
  --display-agent "alice · reviewer" --token task=#12` sets the sidebar label
  without taking over semantic state.
- **Plugin panes:** `[[panes]]` with `placement = split|tab|popup|overlay|zoomed`
  is where our task board TUI goes.

### 2.2 Prior art and what we take from each

| Project | What it is | What we borrow |
|---|---|---|
| [burggraf/pi-teams](https://github.com/burggraf/pi-teams) | Pi extension; port of claude-code-teams-mcp; panes via tmux/Zellij/iTerm2/WezTerm/WT | Tool vocabulary (`team_create`, `spawn_teammate`, `task_*`, `send_message`, `broadcast`, `task_submit_plan`/`task_evaluate_plan`); `teams.yaml` template list; markdown agent definitions; "save running team as template". **Plan mode in practice** (verified in source): `plan_mode_required` is stored but never read. It isn't in the teammate's prompt and isn't enforced. `task_submit_plan` only stores the text and sets `planning`; the lead isn't notified and the teammate isn't told to wait. The plan is mainly for the lead's awareness, and the lead steps in through ordinary messages. **Improve on:** 30 s idle polling, hooks that can't block, file-per-message JSON rewrite, **no stall signal and no way to correct a running agent**. |
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) (Anthropic) | Built-in experimental lead/teammates/task list/mailbox | Task **dependencies** that auto-unblock; **file-locked claiming**; **automatic delivery** (no polling); **idle notification carries the teammate's final answer**; `TaskCreated`/`TaskCompleted`/`TeammateIdle` hooks where **exit 2 = reject + feed stderr back**; shutdown **handshake** (teammate may refuse); inter-agent messages are marked as **not from the user** (a teammate can't relay approvals). |
| [tmustier/pi-agent-teams](https://github.com/tmustier/pi-agent-teams) | Pi port of Claude agent teams | Per-teammate **worktree** option + `/team cleanup`; **auto-claim** of next unblocked task; **urgent** messages that interrupt a working agent (pi `steer` delivery); **stall detection** (no agent event for 5 min, then `⚠ stalled` with time-in-state); hook **failure policy** (`warn` / `reopen` / `followup` / `reopen_followup`, max reopens, follow-up owner); **stall detection** (no activity > N min); `/team done` summary; `/team gc`; `delegate` action (spawn + create tasks in one call). |
| [giuseppecrj/pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) | Async Pi subagents, herdr-only | Proven herdr layout (extension-owned `Agents` tab, **4 panes per tab then overflow tab**, no focus stealing); **worktree contract**: base resolved to exact SHA; one branch per parallel writer; completion report = path, branch, base/head SHA, commits ahead, changed files, clean/dirty/conflicted; **never push/merge/remove on its own**; removal only when clean and no live holder, with `--preserve` WIP commit; `caller_ping` (child asks parent for help); **supervision**: herdr pane state is "the coarse authority", a **no-progress advisory** (default 15 min) fires once per episode and never kills, **interrupt = Esc, which keeps the session**, `stalled`/`recovered` notices go to the parent, and **interactive children stay quiet**; a herdr **sidebar plugin**; model **task categories** (`task:review`, ...) and cross-family review. |
| [modem-dev/pi-herdr-subagents](https://github.com/modem-dev/pi-herdr-subagents) | herdr-native rewrite of [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents); pi children only | **Honest lifecycle:** every child ends in exactly one classified state (completed, help asked, closed by user, failed to launch + pane tail, crashed + exit code, killed). There is "no path to an eternal *stalled* zombie". It **removed** stall heuristics because dead children looked like stalled ones. **No launch race:** launch goes through an argv plugin pane (`[[panes]]` dispatcher that `exec`s a generated launch script) instead of typing into a shell that may still be running direnv. **Long-lived `events.subscribe` socket client** instead of a process per event. **Exit-code sidecar**, because `pane.exited` carries no exit code. A launch failure keeps the pane open for post-mortem. |
| [dantetekanem/pi-extended-teams](https://github.com/dantetekanem/pi-extended-teams) | "Control-first" Pi subagents with live navigation | One-key **message (`m`) / interrupt while keeping context (`i`) / stop (`x`)** on a running agent; verification commands with a limited number of repair attempts; reports keep the agent's *claimed* outcome separate from the *checked* result. |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | Pi delegation + scripted workflows | Worktree **handoff manifest** (patch + metadata) so the orchestrator can apply/inspect; **acceptance gates** (`gate: "npm test"` run by the host, optional JSON output); watchdog/scope monitoring idea. |
| [picassio/pi-fleet](https://github.com/picassio/pi-fleet) | Cross-device Pi orchestration over Tailscale | Single-writer append-only logs (no CRDTs); "state lives at the edges". Cross-machine is **out of scope for v1**; herdr's own remote/SSH support is the natural path later. |

## 3. Decisions

| # | Decision | Status |
|---|---|---|
| D1 | herdr is the only host. No other multiplexer adapters. | **confirmed** |
| D2 | Git worktrees are first-class and managed by the lead (see §7). | **confirmed** |
| D3 | Agent-agnostic core with per-kind **adapters**. v1 ships `claude`, `codex` and `pi`; `opencode` follows. Mixed teams are allowed (e.g. Claude lead + Codex reviewer). | (assumed) |
| D4 | Agents use the team through a **`herdr-teams` CLI** (works from any agent's shell), taught by an injected instruction block/skill. An **MCP server** wrapping the same core comes later for typed tools. | (assumed) |
| D5 | **TypeScript on Node ≥ 20**: same ecosystem as pi-teams, Node is near-universal, and the manifest `[[build]]` runs `npm ci && npm run build`. | (assumed) |
| D6 | Config in `.herdr/` (project) and `~/.config/herdr-teams/` (global). Agent definitions are also **read** from `.pi/agents/` and `.claude/agents/` for compatibility. | (assumed) |
| D9 | **Launch mechanism A:** teammates start in a normal shell pane through `herdr agent start`. That keeps your shell environment and works for every agent kind. The argv plugin pane (pi-herdr-subagents) was considered and rejected. | **confirmed** |
| D7 | **Light enforcement.** Plan mode is a prompt convention plus a team setting, not a sandbox. Determinism goes only where it's cheap and clearly useful: task locking, quality-gate exit codes, and never typing into a `blocked` agent. | **confirmed** |
| D8 | **Live supervision** is a core feature: herdr state, stall advisories, interrupt with context kept, steering and urgent messages (§10). | **confirmed** |

## 4. Architecture

```
┌──────────────────────── herdr server ────────────────────────┐
│ workspace "myrepo"                                           │
│  tab "main":  [lead (claude)]                                │
│  tab "team:auth":  [alice (codex)] [bob (pi)] [board pane]   │
│ workspace "myrepo ⎇ team/auth/carol"  (worktree, grouped)    │
│  tab 1: [carol (claude)]                                     │
└───────▲───────────────────────────▲──────────────────────────┘
        │ herdr CLI / socket        │ event hook: pane.agent_status_changed,
        │                           │ pane.exited, pane.closed, worktree.*
┌───────┴───────────────────────────┴──────────────────────────┐
│ herdr-teams (Node)                                           │
│  cli/        `herdr-teams <cmd>` used by lead, teammates, user│
│  core/       store · tasks · inbox · plans · gates · worktree │
│  herdr/      typed wrapper over $HERDR_BIN_PATH (JSON out)    │
│  adapters/   claude · codex · pi · opencode (argv builders)   │
│  hooks/      event-hook entrypoint → deliver / reconcile      │
│  board/      TUI for the [[panes]] board entrypoint           │
└───────────────────────────┬──────────────────────────────────┘
                            │ files (single source of truth)
              $HERDR_TEAMS_HOME/teams/<team>/...
```

### 4.1 Identity

When a teammate is spawned, its pane gets `--env` values:
`HERDR_TEAMS_HOME`, `HERDR_TEAMS_TEAM=<team>` and `HERDR_TEAMS_AGENT=<name>`.
Every `herdr-teams` call from inside that pane therefore knows who is calling,
so teammates never pass their own name. The lead gets `HERDR_TEAMS_AGENT=lead`
when it creates a team, through the command it runs or the spawn env.
Membership is also verified against `HERDR_PANE_ID` ↔ `config.json` to stop a
teammate from impersonating another.

### 4.2 Storage

`HERDR_TEAMS_HOME` defaults to `$HERDR_PLUGIN_STATE_DIR` (which is per-user).
Each team gets this layout:

```
teams/<team>/
  config.json          # team: name, lead, members[{name, kind, model, thinking,
                       #   pane_id, workspace_id, worktree?, plan_mode, status}]
  tasks/<id>.json      # one file per task; .highwatermark for ids
  inboxes/<agent>.jsonl# append-only messages; cursor file tracks delivered/read
  events.jsonl         # append-only audit log (spawn, claim, gate result, ...)
  plans/<task>-<n>.md  # submitted plans (versioned)
  locks/               # mkdir-based locks (O_EXCL), stale-lock timeout
```

- Writes are atomic: write to a temp file, then `rename`. Claiming, dependency
  updates and status changes run under the task lock. The claim lock follows
  Claude's file-locking approach.
- Inboxes are **append-only JSONL**, so there's no read-modify-write race of the
  kind pi-teams hits with a rewritten JSON file.

### 4.3 Task model

```jsonc
{
  "id": "12", "subject": "Add rate limiter", "description": "...",
  "status": "pending",          // pending | planning | in_progress |
                                // completed | failed | deleted
  "owner": "alice" | null,
  "blockedBy": ["7"], "blocks": [],
  "plan_mode": true,            // write a plan first (see §9)
  "plan": { "version": 2, "path": "plans/12-2.md",
            "verdict": "approved|rejected|null", "feedback": "..." },
  "worktree": { "mode": "auto|shared|dedicated", "branch": "...", ... },
  "gate": "npm test",           // optional per-task acceptance command
  "result": "summary from teammate", "reopens": 0,
  "createdAt": "...", "updatedAt": "..."
}
```

- A task with unresolved `blockedBy` can't be claimed. Completing a task
  unblocks its dependents and notifies their owners.
- **Auto-claim** (default on, per team): when a teammate goes idle with an empty
  inbox, the hook offers it the next unassigned, unblocked task.

### 4.4 Message delivery (the "wake up" mechanism)

The inbox file is the source of truth. Delivery means injecting a prompt.

1. `herdr-teams msg send bob "..."` appends to `inboxes/bob.jsonl`. It then
   **tries immediate delivery**: if bob's herdr status is `idle` or `done`, it
   runs `herdr agent prompt bob "<envelope>"`.
2. If bob is `working`, the message waits. Our `[[events]] on =
   "pane.agent_status_changed"` hook fires when bob turns `idle`, reads the
   undelivered messages and delivers them as **one batched prompt**.
3. If bob is `blocked` (a permission or question UI), we **never** type into
   it, and herdr refuses anyway. Instead the lead gets a notice: "bob is
   blocked".
4. **Urgent** messages (`--urgent`) are delivered while bob is `working`
   instead of waiting. See §10.3 for steering and interrupting.

The envelope marks the sender as an agent, not the user, following Claude's
rule:

```
[herdr-teams] message from alice (teammate, not the user) — team "auth":
<body>
Reply with: herdr-teams msg send alice "..."   |  Tasks: herdr-teams task list
```

**Two event paths, one handler.** The primary path is the team's
**supervisor** (§10.4), a long-lived `events.subscribe` socket client with
millisecond reaction and no per-event process. The fallback is the manifest
`[[events]]` hooks, used when the supervisor isn't running. Both call the
same idempotent handler, so a double delivery is harmless: each message has
an id and a delivered cursor.

**Reconciliation safety net.** Events can be missed (herdr's event history
isn't durable, and it reports `events_lost`). So undelivered mail is also
flushed: (a) on every `herdr-teams` CLI call by any member, (b) by the
supervisor after resubscribing and on its periodic tick, and (c) by the
`[[startup]]` hook after a herdr restart.

### 4.5 Reports to the lead (idle notifications)

When a teammate goes `idle`, the hook sends the lead a compact report. It
contains the task status changes since the last report, plus the teammate's
last message, or the last N lines of `agent read` if it sent none. This matches
Claude's "idle notification carries the final answer". Reports are coalesced
so the lead isn't flooded.

`herdr-teams report "<text>"` is the explicit form, and it's how a teammate
asks for help, like `caller_ping` in pi-herdr-agents.

## 5. Spawning and layout

`herdr-teams spawn <name> [--agent <def>] [--kind claude] [--model M]
[--thinking T] [--plan] [--worktree auto|shared|dedicated] [--placement
split|tab|workspace] --prompt "..."` runs these steps:

1. Resolve the agent definition, model and thinking level (§8).
2. Pick a location:
   - **shared checkout:** the team tab `team:<team>` in the lead's workspace.
     Split right, then down, up to **4 teammate panes per tab**, then open an
     overflow tab (`team:<team>:2`), as pi-herdr-agents does.
   - **dedicated worktree:** `herdr worktree create` opens a grouped
     workspace, and its root pane is used (§7).
   - `--placement tab|workspace` is what pi-teams called "separate OS
     windows".
3. Create the pane: `herdr pane split ... --env HERDR_TEAMS_*=... --no-focus`
   (or reuse a worktree workspace's root pane). It starts your normal
   interactive shell, so rc files, direnv, PATH and API keys are all present.
4. Launch the agent with **`herdr agent start <name> --kind <kind> --pane <id>
   -- <adapter args>`** (D9). herdr waits for the shell prompt, launches the
   canonical binary, and returns once the agent is detected and ready. A
   **launch failure** (an `agent_not_ready` or timeout error, or the agent
   exiting within the start-up window, e.g. a bad `--model`) is reported to
   the lead with the last ~40 lines of the pane. The pane stays at its shell
   for post-mortem.
5. `herdr pane report-metadata` with the display name `alice · reviewer`, a
   title and tokens (`task`, `team`).
6. Send the **bootstrap prompt** with `agent prompt`. It contains the team
   instructions and CLI cheat-sheet, the role body from the agent definition,
   and the spawn prompt. Adapters may instead pass the instructions through a
   system-prompt flag when the CLI supports one.
7. Record the member in `config.json` and append `member.spawned` to
   `events.jsonl`.

**Shutdown handshake:** `herdr-teams shutdown bob` sends a structured request.
Bob replies `herdr-teams shutdown --accept|--reject "reason"`. On accept, the
plugin exits the agent through adapter-specific keys or `/exit`, releases
bob's in-progress tasks back to `pending`, and closes the pane.
`herdr-teams kill bob` forces it. `herdr-teams done` ends the whole run and
prints a summary.

## 6. Agent adapters

Each adapter maps the shared settings onto one CLI. **Every flag in this list
must be verified against the current CLI before we implement it.**

| Concern | claude | codex | pi |
|---|---|---|---|
| model | `--model <m>` | `-m <m>` | `--model <provider/m>` |
| thinking | effort setting / `--settings` | `-c model_reasoning_effort=<lvl>` | `--thinking <lvl>` |
| extra instructions | `--append-system-prompt` | `-c experimental_instructions_file` / AGENTS.md | `--append-system-prompt` (verify) |
| exit | `/exit` | `/quit` | `/quit` (verify) |
| interrupt turn, keep context | `esc` | `esc` | `esc` |
| steer while working (§10.3) | typed prompt is picked up mid-turn (verify) | Enter steers / Tab queues (verify by version) | native `steer` queue |
| progress probe (§10.2) | screen hash | screen hash | screen hash, plus session JSONL mtime (optional) |

Thinking levels are normalized to `off | minimal | low | medium | high | xhigh`
and each adapter maps them to the closest native value.

## 7. Git worktrees (lead-managed)

Worktrees isolate **checkouts**, not processes or permissions. Each teammate
still runs as your user.

**Modes.** You can set a mode per teammate and override it per task:

- `shared`: work in the lead's checkout (fine for read-only or single-writer
  work).
- `dedicated`: the teammate gets its own worktree when it is spawned.
- `auto`: the teammate starts shared. A worktree is created **when it claims a
  task that is marked `worktree: true`**, or when the lead approves a request.

**Who creates them.** The lead owns them:

- `herdr-teams worktree create <member|task> [--branch] [--base]` (lead only).
- A teammate can ask with
  `herdr-teams worktree request --reason "parallel edits to src/auth"`. This
  becomes a structured message to the lead. The lead runs
  `herdr-teams worktree approve <req>`, or a team policy
  `worktree_requests: auto` approves it immediately.

**Creating one:**

1. Resolve `base` to an exact SHA, default the lead's committed `HEAD`.
   Uncommitted lead changes are **not** carried over, and a warning says so.
2. Use the branch name `team/<team>/<member>[-<task>]`. Branches must be
   unique; reuse is refused.
3. Run `herdr worktree create --cwd <repo> --branch <b> --base <sha>
   --label "<team>:<member>" --no-focus`. This opens a grouped workspace.
4. The teammate runs in that workspace's root pane, or is moved there with
   `pane move` if it already exists. Moving keeps the agent session alive.
5. Record the `worktree` in the member and task (path, branch, base SHA).

**Completion report.** When a task completes in a worktree, the report
contains the path, branch, base and head SHA, commits ahead, changed files,
and whether the checkout is clean, dirty or conflicted.

**Integration.** This stays with the lead:

- `herdr-teams worktree status [member]`
- `herdr-teams worktree diff <member>`
- `herdr-teams worktree merge <member> [--into <branch>] [--squash]`: runs a
  local merge only **when the lead runs it explicitly**. It aborts and reports
  if there are conflicts.

The plugin **never** pushes, opens PRs, or merges on its own.

**Cleanup.** `herdr-teams worktree remove <member> [--preserve]` is refused
unless:

- the checkout is clean, or `--preserve` first makes a WIP commit;
- no live agent is in the worktree workspace;
- the branch has been merged, or `--force-unmerged` is given.

It never deletes branches unless `--delete-branch` is given. `herdr-teams
cleanup` and `gc` list leftovers.

**Gates run in the task's worktree** (§9).

## 8. Templates and agent definitions

### Agent definitions

Agent definitions are markdown files with frontmatter. The body is the role
instructions.

```markdown
---
name: reviewer
description: Reviews diffs for correctness and security
kind: codex            # herdr agent kind (default: team default / lead's kind)
model: gpt-5.4
thinking: high
plan_mode: false
worktree: shared       # shared | dedicated | auto
auto_claim: true
tools: read, bash      # advisory; adapters enforce where the CLI supports it
---
You review changes only. Report findings with file:line ...
```

Search order: `.herdr/agents/`, then `~/.config/herdr-teams/agents/`, then the
compatibility folders `.pi/agents/` and `.claude/agents/`. Unknown keys are
ignored, so Claude and pi definitions load as they are.

### `teams.yaml`

The file lives at `.herdr/teams.yaml` or `~/.config/herdr-teams/teams.yaml`.
It is a superset of the pi-teams format: a bare list still works.

```yaml
plan-build:               # pi-teams compatible short form
  - planner
  - builder
  - reviewer

auth-squad:
  description: Rework authentication
  lead: { kind: claude, model: opus }
  defaults: { kind: claude, thinking: medium, worktree: auto }
  hooks: { failure_action: reopen_followup, max_reopens: 2 }
  members:
    - name: alice
      agent: builder
      worktree: dedicated
    - name: bob
      agent: reviewer
      kind: codex
      plan_mode: false
  tasks:                  # optional seed tasks
    - subject: Map current auth flow
      owner: bob
```

`herdr-teams team save <template> [--scope project|global]` writes the running
team back to these files. For each teammate it writes an agent definition if
one doesn't exist yet, then updates `teams.yaml`.

## 9. Plan approval and quality gates

### Plan approval (light)

Plan mode is a **convention, not a sandbox** (D7). It works like pi-teams,
with two improvements: the lead is told about the plan, and the teammate hears
the verdict.

- **Opt-in.** Set `plan_mode: true` on an agent definition, a teammate at
  spawn, or a single task.
- **Instruction-based.** The bootstrap prompt (or the task-assignment prompt)
  says: "before changing code for this task, write a plan and run
  `herdr-teams plan submit <task> --file plan.md`". Teammates keep all their
  tools; nothing is locked down.
- **Submitting** stores the plan as `plans/<task>-<n>.md`, sets the task to
  `planning`, and puts a short message in the lead's inbox (the subject, the
  plan's path, and its first lines), so the lead knows without polling.
- **Waiting is a team setting.** It changes only what the teammate is told
  to do:

  | `plan_approval` | Teammate is told to... | Lead's role |
  |---|---|---|
  | `none` (pi-teams behaviour) | submit, then **continue** | read it for awareness and step in with a normal message if needed |
  | `lead` (default) | submit, then **stop and wait** for a reply | review, then `plan approve` or `plan reject --feedback` |

  A single member or task can override the team setting.
- **Verdicts are just messages.** `herdr-teams plan approve <task>` and
  `plan reject <task> --feedback "..."` are shortcuts. They record the
  verdict on the task, set the status (`in_progress` or `planning`), and
  send the teammate an ordinary inbox message. herdr delivers it as soon as
  the waiting teammate is idle, so it never has to check.
- A late verdict, sent after the teammate has already moved on, is still
  recorded and delivered. It is not an error, unlike in pi-teams.
- If you want to see plans yourself, tell the lead so in plain language (for
  example "show me plans before approving"). There is no human-approval mode
  in v1.

### Quality-gate hooks

Hooks live in `.herdr/teams/hooks/` or `~/.config/herdr-teams/hooks/`. Each is
any executable named after its event:

| Hook | When it runs | Exit 2 means |
|---|---|---|
| `task_created` | before a task is stored | reject the task; stderr goes to the creator |
| `task_completed` | before a task becomes `completed` | **reject the completion**: the task stays `in_progress`, stderr goes to the owner |
| `teammate_idle` | when a teammate goes idle | keep it working; stderr becomes its next prompt |
| `plan_submitted` | before the lead is notified | auto-reject with feedback (e.g. a plan without a test strategy) |

Exit 0 lets the action through. Any other code is a hook failure, handled by
the team's **failure policy** (`warn | reopen | followup | reopen_followup`,
`max_reopens`, follow-up owner `member|lead|none`, from pi-agent-teams).

Each hook gets JSON on stdin and the env vars `HERDR_TEAMS_EVENT`, `_TEAM`,
`_AGENT`, `_TASK_ID` and `_TASK_JSON`. It runs with cwd set to the task's
**worktree** (or the shared checkout) and has a timeout (default 10 min). A
task can also carry `gate: "<cmd>"`, a per-task acceptance command (from
pi-subagents) that runs before the hook.

pi-teams' `.pi/team-hooks/task_completed.sh` is detected and run with its old
argument convention.

## 10. Live supervision

pi-teams gives no real signal when an agent is stuck and no way to correct
it mid-run. herdr-teams makes **seeing** and **correcting** running
teammates a core feature (D8). The rule throughout comes from
pi-herdr-agents: **supervision is advisory**. It informs the lead and you,
but it never kills, restarts or retries an agent on its own.

### 10.1 State: herdr is the authority

Live state comes from **herdr's agent state**, not from guessing at output.
herdr detects it per agent (screen manifests, or the agent's own state
reports) as `idle`, `working`, `blocked`, `done` or `unknown`, and it is more
reliable than any heuristic of our own.

- The `pane.agent_status_changed` hook records every transition in
  `events.jsonl` with a timestamp. Time-in-state ("working 12m",
  "blocked 3m") is computed from that log, with no extra polling.
- `completion_seq` from herdr marks real finished turns, as opposed to
  start-up or restored idle, so an "idle" report always means work finished.
- Team-level states are derived from herdr state plus our own records:

  | Member state | Derived from |
  |---|---|
  | `starting` | spawned, `agent start` not yet returned |
  | `working` / `idle` / `blocked` | herdr state |
  | `waiting-plan` | idle, with a submitted plan and `plan_approval: lead` |
  | `interrupted` | we sent an interrupt and it hasn't started a new turn |
  | `stalled` | §10.2 advisory is active |
  | `exited` | see the end states below |

- **Every member ends in exactly one honest state** (pi-herdr-subagents),
  each with a single report to the lead:

  | End state | Evidence |
  |---|---|
  | `shut-down` | shutdown handshake accepted, then the agent exited |
  | `closed-by-user` | the pane or agent was closed with no handshake, after a human focused it |
  | `failed-to-launch` | exited within the start-up window; report includes the pane tail and launch argv |
  | `crashed` | exited or vanished later; report includes the pane tail and the session ref (`agent_session`) for resume (no exit code; see §14) |
  | `killed` | `herdr-teams kill` |

  A member that **exits** is never shown as `stalled`. Exit detection comes
  from events (the agent disappearing from its shell pane, `pane.exited`,
  `pane.closed`), not from a quiet screen.

### 10.2 Stall detection (advisory)

Exited and crashed agents are handled by the end states above, **not**
here. pi-herdr-subagents removed stall heuristics because a dead child "looks
like a screen that stopped changing"; this design avoids that by checking
liveness first, from events. What remains is the case pi-herdr-subagents
lists as a known gap: an agent that is **alive but not making progress**.
Being stuck means **no progress**, not long run time; a long `working`
state is normal for big tasks (pi-herdr-agents). Progress evidence is
anything the team can observe, in any agent CLI:

1. a herdr state transition;
2. team activity by the member: a `herdr-teams` CLI call, a message, or a
   task update;
3. **screen change**. The supervisor samples
   `herdr agent read <m> --source recent --lines 40` and hashes it. A
   spinner-only change doesn't count (`terminal_title_stripped` and
   normalization handle that).

| Condition | Default threshold | Advisory kind |
|---|---|---|
| `working` with no progress evidence | 10 min | `no-progress` |
| `blocked` (permission or question prompt) | 2 min | `needs-input`: this needs a **human**, since the lead must not answer permission prompts |
| `unknown` | 5 min | `unclassified` |

Each advisory is sent **once per episode** to the lead as an inbox message.
A matching `recovered` notice follows when progress resumes. The advisory
says what was observed and suggests recovery: `peek`, `nudge`, `interrupt`
or `kill`. Thresholds are team settings (`supervision.no_progress_minutes`
and so on), and `0` disables one.

Other notice paths:
- `needs-input` also raises a **herdr notification** so the human sees it.
- **Interactive members stay quiet.** If a human focused the member's pane
  recently (the `pane.focused` hook) or the member is marked
  `interactive: true`, advisories go to the board only, not to the lead.
- **Optional auto-nudge.** With `supervision.on_no_progress: nudge`, the
  supervisor sends one gentle prompt ("status check: reply with
  `herdr-teams report`...") before telling the lead. The default is
  `notify`.

### 10.4 The supervisor process

Event hooks can't notice that *nothing* happened, and herdr plugins can't run
background daemons. So each team has one **supervisor**: a small Node process
in its own narrow pane in the team tab (`herdr-teams supervise`), opened as a
plugin `[[panes]]` entrypoint. It shows a one-line status, and its lifetime
is tied to the pane, as herdr requires.

- **Events:** it holds an `events.subscribe` socket connection for
  `pane.agent_status_changed`, `pane.exited`, `pane.closed`, `pane.moved`
  and `pane.focused` on member panes. On `events_lost` it resubscribes and
  reconciles from `session.snapshot`, following herdr's documented recovery
  steps.
- **Clock:** a ~30 s tick for stall checks and screen-hash sampling.
- **Fallback:** if the supervisor is closed, the manifest event hooks and
  the CLI reconciliation still deliver mail and record state. Only
  time-based advisories pause, and the board shows "supervisor offline".
  The `[[startup]]` hook reopens it after a herdr restart.

### 10.3 Correcting a running agent

Four levels, from gentlest to strongest. The lead uses them through the CLI;
you use them from the board pane's keys (as in pi-extended-teams).

| Action | CLI | Board key | Mechanism | Context |
|---|---|---|---|---|
| **Peek** | `herdr-teams peek bob [--lines 80]` | `enter` | `herdr agent read`; or focus the pane | n/a |
| **Message** (queued) | `msg send bob "..."` | `m` | inbox; delivered at idle (§4.4) | kept |
| **Steer / urgent** | `msg send bob --urgent "..."` or `steer bob "..."` | `u` | while `working`: adapter steer (see below) | kept |
| **Interrupt** | `interrupt bob [--then "new instructions"]` | `i` | `herdr agent send-keys bob esc`, wait for `idle`, then optionally prompt | **kept**: the turn is cancelled, the session stays |
| **Stop task** | `task release 12 [--reason]` | `r` | interrupt, then return the task to `pending` and tell bob why | kept |
| **Kill** | `kill bob` | `x` | close the pane; tasks go back to `pending` | lost |

**Steering by adapter:**
- `native`: pi's `steer` queue. Claude Code and Codex also pick up a prompt
  typed during a turn; this needs checking per CLI version (M3 spike).
- `interrupt-then-prompt`: the fallback for any CLI that can't steer
  safely. It sends Esc, waits for idle, then sends the urgent message as the
  next prompt.

Steering never types into a `blocked` agent; herdr refuses with
`agent_blocked`, and we report that instead.

Authority: any member can send urgent messages. Only the lead (or you, from
outside the team) can `interrupt`, `task release` or `kill` another member.
This is checked by caller identity (§4.1). It's a guardrail, not a security
boundary.

## 11. Board pane and observability

- **Board pane** (`[[panes]] id = "board"`, placement `split` by default): a
  live TUI with columns per status. It shows dependencies, owners, worktree
  and branch, unread counts and the last messages. A **member strip** shows
  each member's derived state, time in state and active advisories (`⚠
  no-progress 12m`, `✋ needs-input`). Keys work as in §10.3, plus assign,
  reopen and plan approve or reject. The board reads state that the
  supervisor (§10.4) maintains, so it can be closed at any time.
- **Sidebar:** each member's tokens (`$task`, `$team`, `$branch`, `$advice`)
  show in herdr Agent rows, and state labels override herdr's for display
  (e.g. `working` becomes "#12 rate limiter"). A team-level summary goes into
  the workspace token (`$team_status = "3/7 done · 1 stalled"`).
- `herdr-teams status [member]` gives the same view as JSON or text for the
  lead (like pi-agent-teams' `member_status`).
- `events.jsonl` doubles as an audit trail: `herdr-teams log [--follow]`.

## 12. Plugin manifest (sketch)

```toml
id = "herdr-teams"
name = "herdr teams"
version = "0.1.0"
min_herdr_version = "0.9.0"
platforms = ["linux", "macos"]     # windows later

[[build]]
command = ["npm", "ci"]
[[build]]
command = ["npm", "run", "build"]

[[startup]]                         # reconcile after server restart
command = ["node", "dist/bin/herdr-teams.js", "_hook", "startup"]

[[events]]
on = "pane.agent_status_changed"    # wake-up + idle reports + auto-claim
command = ["node", "dist/bin/herdr-teams.js", "_hook", "event"]
[[events]]
on = "pane.exited"                  # member died → release tasks, tell lead
command = ["node", "dist/bin/herdr-teams.js", "_hook", "event"]
[[events]]
on = "pane.closed"
command = ["node", "dist/bin/herdr-teams.js", "_hook", "event"]
[[events]]
on = "pane.moved"                   # keep pane ids current
command = ["node", "dist/bin/herdr-teams.js", "_hook", "event"]

[[actions]]
id = "start-team"                   # pick a teams.yaml template
title = "Start team from template"
contexts = ["workspace"]
command = ["node", "dist/bin/herdr-teams.js", "_action", "start-team"]

[[actions]]
id = "open-board"
title = "Open team board"
contexts = ["workspace"]
command = ["node", "dist/bin/herdr-teams.js", "_action", "open-board"]

[[panes]]
id = "board"
title = "Team board"
placement = "split"
command = ["node", "dist/bin/herdr-teams.js", "board"]

[[panes]]
id = "supervisor"                   # one per team, §10.4
title = "Team supervisor"
placement = "split"
command = ["node", "dist/bin/herdr-teams.js", "supervise"]

```

The `herdr-teams` CLI also has to be on the agents' `PATH`. The spawn env
prepends `$HERDR_PLUGIN_ROOT/bin`, so a teammate can always call it, and
`herdr-teams install-shim` can link it for the lead.

## 13. Milestones

| M | Deliverable | Done when |
|---|---|---|
| **M0** | Repo skeleton: TS, lint, vitest, manifest, `herdr` wrapper with a **fake-herdr test double** (records calls, scripted JSON replies) | `herdr plugin link .` succeeds; CI green |
| **M1** | Core store: teams, tasks (deps, claim lock, statuses), inboxes (JSONL + cursors), events log; CLI `team/task/msg` | Concurrency tests: 20 parallel claimers, exactly one wins |
| **M2** | Spawn + lifecycle on herdr: layout policy, claude/codex/pi adapters, metadata, shutdown handshake, kill, done | Lead in claude spawns codex + pi teammates in a real herdr session |
| **M3** | Delivery + **live supervision core**: event hook, batched delivery, idle reports to lead, auto-claim, reconcile; state log and time-in-state; `peek`, `interrupt` (Esc, context kept), urgent/steer with the interrupt-then-prompt fallback; crash handling; **steering spike** per CLI | Idle teammate wakes within ~1 s of a message, with no polling; an interrupted teammate continues with new instructions and its context intact |
| **M3b** | Supervisor pane (`events.subscribe`, `events_lost` recovery, tick), honest end states, launch-failure reports; no-progress / needs-input / unclassified advisories, once per episode, `recovered` notices, interactive-member quieting, optional auto-nudge | A frozen fake agent produces exactly one advisory and one `recovered` |
| **M4** | Worktrees: modes, request/approve, create/move, completion report, status/diff/merge, guarded remove, cleanup/gc | Two writers in parallel worktrees, lead merges both |
| **M5** | Light plan mode (`plan_approval: none|lead`, verdicts as messages) + hooks with exit-2 semantics + failure policy | Failing `npm test` gate keeps the task open and tells the owner why |
| **M6** | Agent definitions, `teams.yaml`, `team start <template>`, `team save` | Round-trip: save a team, start it again |
| **M7** | Board pane TUI (member strip, §10.3 keys) + sidebar tokens/labels | Board usable as the only control surface |
| **M8** | MCP server front-end, opencode/gemini adapters, Windows check, docs, marketplace topic `herdr-plugin` | Published, installable via `herdr plugin install sonhal/herdr-teams` |

### Testing strategy

- **Unit tests** for the store, dependency graph, locking, policy resolution
  and adapters' argv building.
- **Contract tests** against the fake `herdr` (which commands were called, with
  what argv), plus golden JSON from the herdr API schema
  (`docs/next/api/herdr-api.schema.json` upstream).
- **End-to-end smoke test:** a scripted run in a real herdr session using a
  trivial "echo agent" (a shell script that reports state through
  `pane report-agent`). This needs no API keys.

## 14. Open questions and risks

1. **Steering while working:** check per CLI and version that a prompt
   typed during a turn is steered or queued safely, and doesn't corrupt an
   in-progress tool approval. Otherwise use `interrupt-then-prompt` (M3 spike).
2. **Stall false positives:** long silent test runs or builds look like no
   progress on screen. Mitigate with generous defaults, team-activity
   evidence, and advisories that never act on their own. Revisit after
   dogfooding.
3. **Prompt injection between agents:** message bodies are untrusted. The
   envelope says so, and gates and approvals never accept "approved" text
   relayed by a teammate. Only the lead's CLI identity can approve.
4. **Event-hook process cost:** each status change spawns a Node process.
   Measure it. If it's too slow, have the hook do a tiny fast-path check (for
   example "is this pane a team member?" from a cached index) and exit early.
5. **Team scope:** should several teams run at once in one herdr session? The
   plan supports several, each addressed by `--team`, with the current team
   taken from env.
6. **Nested teams:** can teammates spawn helpers? Not in v1; Claude doesn't
   allow it either. A teammate can still use its CLI's own subagents.
7. **Launch robustness** (D9): test `agent start` in M2 against a slow shell
   (a `sleep 3` in rc), direnv, and a bad `--model`. Make sure failures are
   reported, not silent.
8. **Detecting agent exit:** the pane survives (it drops back to the
   shell), so `pane.exited` doesn't fire. Detect the exit from the agent
   disappearing (`pane.agent_status_changed`, or `agent get` failing), and
   check that herdr emits a usable event for it.
