# herdr-teams — Design Plan

> **Status:** M0 skeleton and M1 core store implemented; M2 is next.

## Contents

1. [Overview](#1-overview)
2. [Scope](#2-scope)
3. [Concepts](#3-concepts)
4. [Architecture](#4-architecture)
5. [Team lifecycle](#5-team-lifecycle)
6. [Task board](#6-task-board)
7. [Communication](#7-communication)
8. [Plan mode](#8-plan-mode)
9. [Quality gates](#9-quality-gates)
10. [Git worktrees](#10-git-worktrees)
11. [Live supervision](#11-live-supervision)
12. [Board and observability](#12-board-and-observability)
13. [Agent adapters](#13-agent-adapters)
14. [Configuration](#14-configuration)
15. [CLI reference](#15-cli-reference)
16. [Plugin manifest](#16-plugin-manifest)
17. [Milestones and testing](#17-milestones-and-testing)
18. [Open questions and risks](#18-open-questions-and-risks)
- [Appendix A: herdr primer for implementers](#appendix-a-herdr-primer-for-implementers)
- [Appendix B: Influences](#appendix-b-influences)

---

## 1. Overview

herdr-teams is a [herdr](https://github.com/ogulcancelik/herdr) plugin that
lets one coding agent, the **lead**, run a team of **persistent, named
teammates**. Teammates coordinate through a **shared task board** and talk
through **peer inboxes**. Each teammate is a real coding-agent CLI (Claude
Code, Codex, pi, …) running in its own herdr pane, so you can watch it, type to
it, and see its state in herdr's sidebar.

### Design principles

- **herdr-native.** herdr provides the panes, tabs, workspaces, git
  worktrees, agent start-up, prompting and agent-state detection. There are no
  adapters for other terminal multiplexers.
- **Agent-agnostic.** The team works through a `herdr-teams` CLI that any
  agent can run from its shell. Small per-agent adapters cover the
  differences, and mixed teams (e.g. a Claude lead with a Codex reviewer) are
  normal.
- **Push, don't poll.** Messages and notices are delivered as soon as herdr
  reports that the recipient is idle.
- **Light enforcement.** Rules are conveyed through prompts and team
  settings. Hard guarantees are kept to the few places where they are cheap
  and clearly useful: task-claim locking, quality-gate exit codes, and never
  typing into an agent that is waiting on a permission prompt.
- **Supervision is advisory.** The plugin reports stalls and failures to the
  lead and the user, and it offers tools to correct a running agent. It never
  kills, restarts or retries an agent on its own.
- **Honest state.** Every teammate is always in one well-defined state, and
  every teammate ends in exactly one classified end state.

## 2. Scope

### In scope (v1)

| Area | Features |
|---|---|
| Team | Spawn named teammates with their own agent CLI, model and thinking level; show them as herdr panes, tabs or worktree workspaces; `teams.yaml` templates; save a running team as a template; markdown agent definitions |
| Coordination | Persistent task board with statuses and dependencies; file-locked claiming and auto-claim; plan mode; quality-gate hooks |
| Communication | Direct messages, broadcast, reports to the lead; pushed delivery when idle; urgent messages while working |
| Worktrees | Per-teammate or per-task git worktrees managed by the lead; completion reports; explicit merge and guarded cleanup |
| Supervision | Live state from herdr, time in state, stall advisories, honest end states; peek, steer, interrupt with context kept, release task, kill |
| Visibility | Board pane, supervisor pane, herdr sidebar labels, event log |

### Not in v1

- Other terminal multiplexers (tmux, Zellij, iTerm2, WezTerm, Windows
  Terminal).
- Cross-machine teams. herdr's remote support is the likely path later.
- Nested teams: teammates spawning their own teammates. A teammate may still
  use its CLI's own subagents.
- Sandboxing or permission enforcement. Teammates run as the user.
- Human-in-the-loop plan approval as a mode. You can still instruct the lead
  to show you plans.
- Windows (planned after v1).

## 3. Concepts

| Term | Meaning |
|---|---|
| **Team** | A named group of agents with one task board, one inbox per member, and its own settings. Several teams can run in one herdr session. |
| **Lead** | The agent that creates and coordinates the team: it spawns teammates, creates and assigns tasks, reviews plans, and merges worktrees. Usually the agent you're talking to. |
| **Teammate / member** | A named agent (`[a-z][a-z0-9_-]{0,31}`) running in its own herdr pane, with its own agent CLI, model and thinking level. |
| **Agent definition** | A markdown file describing a reusable role: agent CLI, model, defaults, and instructions. |
| **Template** | A team definition in `teams.yaml`: members, settings and optional seed tasks. |
| **Task** | A unit of work on the board, with a status, an owner, dependencies and an optional plan, worktree and gate. |
| **Inbox** | A member's append-only message log. |
| **Supervisor** | One small process per team, in its own pane, that receives herdr events and runs time-based checks. |
| **Board** | A pane with a live task board and member strip, used by the human. |

## 4. Architecture

```
┌──────────────────────────── herdr server ─────────────────────────────┐
│ workspace "myrepo"                                                    │
│   tab "main":       [ lead (claude) ]                                 │
│   tab "team:auth":  [ alice (codex) ][ bob (pi) ][ supervisor ]       │
│ workspace "myrepo ⎇ team/auth/carol"   (git worktree, grouped)        │
│   tab 1:            [ carol (claude) ]                                │
└──────▲──────────────────────────────▲─────────────────────────────────┘
       │ herdr CLI ($HERDR_BIN_PATH)  │ events.subscribe (supervisor)
       │                              │ [[events]] hooks (fallback)
┌──────┴──────────────────────────────┴─────────────────────────────────┐
│ herdr-teams (TypeScript, Node ≥ 20)                                   │
│   cli/         `herdr-teams <command>`: used by the lead, teammates,  │
│                and the user                                           │
│   core/        store · tasks · inbox · plans · gates · worktrees      │
│   herdr/       typed wrapper around the herdr CLI (JSON in/out)       │
│   adapters/    claude · codex · pi (· opencode later)                 │
│   supervisor/  event subscriber, delivery, advisories, clock          │
│   board/       task-board TUI                                         │
└────────────────────────────────┬──────────────────────────────────────┘
                                 │ files = single source of truth
                       $HERDR_TEAMS_HOME/teams/<team>/
```

### 4.1 Components

- **CLI (`herdr-teams`).** The only interface. Agents call it from their
  shell; the user calls it from any terminal. Commands are in §15.
- **Core.** Pure logic over the file store: tasks, dependency graph,
  inboxes, plans, gates and worktree bookkeeping.
- **herdr wrapper.** Calls `$HERDR_BIN_PATH` and parses JSON results. It is
  the only module that talks to herdr, which keeps a fake herdr easy to
  swap in for tests.
- **Adapters.** Turn the shared settings (model, thinking level, exit,
  steering) into each agent CLI's arguments and keys (§13).
- **Supervisor.** A long-running process in a plugin pane (§11.5).
- **Board.** A TUI in a plugin pane (§12).
- **Plugin manifest.** Wires the startup hook, event hooks, actions and
  panes into herdr (§16).

### 4.2 Identity

Each teammate's pane is created with these environment variables:
`HERDR_TEAMS_HOME`, `HERDR_TEAMS_TEAM=<team>` and `HERDR_TEAMS_AGENT=<name>`.
Every `herdr-teams` call from inside that pane therefore knows who is calling,
so agents never pass their own name. The lead's identity is set when it
creates the team. The membership record also stores each member's
`HERDR_PANE_ID` as a cross-check.

Identity decides who may do what. Only the lead (or the user, from outside
the team) may interrupt, release, kill, approve plans and manage worktrees.
This is a guardrail against mistakes, not a security boundary: every agent
runs as the user.

### 4.3 Storage

`HERDR_TEAMS_HOME` defaults to herdr's `$HERDR_PLUGIN_STATE_DIR`. herdr sets
that only for plugin processes, so inside an ordinary herdr pane the CLI
derives the same path. A team records the `HERDR_SOCKET_PATH` of the session
that created it; hooks and commands from another session leave it alone.

```
teams/<team>/
  config.json            # team settings and members
                         #   {name, kind, model, thinking, pane_id,
                         #    workspace_id, worktree, plan_mode, state}
  tasks/<id>.json        # one file per task; .highwatermark holds the next id
  inboxes/<agent>.jsonl  # append-only messages
  inboxes/<agent>.cursor # last delivered message id
  plans/<task>-<n>.md    # submitted plans, versioned
  events.jsonl           # append-only log: state changes, claims, gates, ...
  locks/                 # mkdir-based locks with a stale-lock timeout
```

- Writes are atomic: write to a temp file, then rename.
- Claiming a task, changing its status and editing dependencies all happen
  under the task's lock.
- Inboxes and the event log are append-only, so concurrent writers never
  overwrite each other.

## 5. Team lifecycle

### 5.1 Starting a team

`herdr-teams team start <template>` (or `team create <name>` for an empty
team) does the following:

1. Creates the team directory and records the caller as lead.
2. Opens the supervisor pane, unless `supervisor.mode: off`.
3. Spawns each member (§5.2).
4. Creates any seed tasks from the template.

### 5.2 Spawning a teammate

```
herdr-teams spawn <name> [--agent <definition>] [--kind claude|codex|pi]
    [--model M] [--thinking T] [--plan-mode] [--worktree shared|dedicated|auto]
    [--placement split|tab|workspace] --prompt "..."
```

1. **Resolve settings.** Flags override the agent definition, which
   overrides the team defaults, which override the lead's own agent CLI and
   model.
2. **Choose a location.**
   - Shared checkout: the team tab `team:<team>`. Splits go right, then down,
     with up to 4 teammates per tab; extra teammates go into an overflow
     tab `team:<team>:2`.
   - Dedicated worktree: a new grouped worktree workspace (§10), using its
     root pane.
   - `--placement tab|workspace` puts the teammate in its own tab or
     workspace.
3. **Create the pane:** `herdr pane split … --env HERDR_TEAMS_*=… --no-focus`.
   The pane starts the user's normal interactive shell, so rc files,
   direnv, PATH and API keys are all available. New panes never take focus.
4. **Launch the agent:**
   `herdr agent start <name> --kind <kind> --pane <id> -- <adapter args>`.
   herdr waits for the shell prompt, launches the agent, and returns once it
   detects the agent ready for input.
5. **Label it:** `herdr pane report-metadata` sets the display name
   (`alice · reviewer`), a title and sidebar tokens.
6. **Bootstrap:** `herdr agent prompt` sends the opening prompt. It covers
   who the teammate is, the team roster, the `herdr-teams` cheat-sheet, the
   definition's role instructions, plan-mode instructions if enabled, and the
   spawn prompt.
7. **Record:** the member is added to `config.json`, and `member.spawned` is
   logged.

**Launch failures.** If `agent start` errors or times out, or the agent exits
within the start-up window (e.g. because of a bad `--model`), the member's end
state is `failed-to-launch`. The lead gets the launch arguments and the last
~40 lines of the pane, and the pane is kept open for inspection.

### 5.3 Ending

- **Graceful:** `herdr-teams shutdown <name>` sends a shutdown request. The
  teammate replies `herdr-teams shutdown --accept` or
  `--reject "<reason>"`. On accept, the adapter exits the agent, the
  teammate's in-progress tasks return to `pending`, and the pane is closed.
- **Forced:** `herdr-teams kill <name>`.
- **Whole team:** `herdr-teams done [--force]` shuts every teammate down and
  prints a summary. Without `--force` it refuses while tasks are in
  progress.
- **Save:** `herdr-teams team save <template> [--scope project|global]`
  writes the team to `teams.yaml`, and creates an agent definition for any
  member that doesn't have one.
- **Cleanup:** `herdr-teams cleanup` lists and removes leftover worktrees
  (with the safety rules in §10) and old team directories.

## 6. Task board

### 6.1 Task model

```jsonc
{
  "id": "12",
  "subject": "Add rate limiter",
  "description": "...",
  "status": "pending",        // pending | planning | in_progress | completed | failed | deleted
  "owner": "alice",           // or null
  "blockedBy": ["7"],
  "blocks": [],
  "plan_mode": true,          // §8
  "plan": { "version": 2, "path": "plans/12-2.md",
            "verdict": "approved", "feedback": null },
  "worktree": { "required": true, "branch": "team/auth/alice-12" },  // §10
  "gate": "npm test",         // §9
  "result": "Summary written by the teammate",
  "reopens": 0,
  "createdAt": "...", "updatedAt": "..."
}
```

### 6.2 Rules

- A task whose `blockedBy` tasks aren't all completed can't be claimed.
  Completing a task unblocks its dependents and notifies their owners.
- Claiming is atomic under the task lock, so exactly one claimer wins.
- **Auto-claim** (team setting, on by default): a teammate that goes idle
  with an empty inbox is offered the next unassigned, unblocked task.
- When a member ends without a graceful shutdown, its in-progress tasks
  return to `pending` and the lead is told.

## 7. Communication

### 7.1 Message types

| Command | Recipient | Delivery |
|---|---|---|
| `msg send <name> "…"` | one member | when idle |
| `msg send <name> --urgent "…"` / `steer <name> "…"` | one member | immediately, even while working (§11.4) |
| `broadcast "…"` | all members | when each is idle |
| `report "…"` | the lead | when idle; also how a teammate asks for help |

Messages can also be structured, for example a plan submission, plan verdict,
shutdown request, worktree request or advisory. Structured messages travel
through the same inboxes.

### 7.2 Delivery

The inbox is the source of truth; delivering a message means typing it into
the agent with `herdr agent prompt`.

1. Sending appends the message to the recipient's inbox, then tries to
   deliver it right away if the recipient is `idle` or `done`.
2. If the recipient is `working`, the message waits. When herdr reports it
   idle, all waiting messages are delivered as **one batched prompt**.
3. If the recipient is `blocked` (a permission or question prompt), nothing
   is typed; herdr refuses anyway. The message waits, and the lead is told.

Every delivered message is wrapped so that the agent knows it came from a
teammate, not from the user:

```
[herdr-teams] message from alice (teammate, not the user) — team "auth":
<body>
Reply: herdr-teams msg send alice "…"   ·   Tasks: herdr-teams task list
```

Message bodies are untrusted. A teammate's text claiming that the user
approved something counts for nothing; only the real commands change state.

### 7.3 Event paths and reconciliation

- **Primary:** the team's supervisor holds a long-lived
  `events.subscribe` connection and reacts within milliseconds (§11.5).
- **Fallback:** the manifest's `[[events]]` hooks run the same handler when
  the supervisor isn't running.
- The handler is idempotent: messages have ids and each inbox has a delivered
  cursor, so a double trigger is harmless.
- **Reconciliation:** events can be lost, so waiting mail is also flushed on
  every `herdr-teams` call, on the supervisor's periodic tick and after it
  resubscribes, and by the startup hook after a herdr restart.

### 7.4 Reports to the lead

When a teammate finishes a turn and goes idle, the lead automatically gets a
short report. It contains the board changes since the last report, plus the
teammate's last message or, if there was none, the last lines of its output.
Reports are coalesced so the lead isn't flooded. Advisories (§11.3) and end
states (§11.2) reach the lead the same way.

## 8. Plan mode

Plan mode asks a teammate to think before coding. It is a **convention, not
a sandbox**: teammates keep all their tools.

- **Opt-in:** `plan_mode: true` on an agent definition, at spawn, or on a
  single task.
- **Instruction:** the teammate is told to write a plan and run
  `herdr-teams plan submit <task> --file plan.md` before changing code for
  the task.
- **Submit:** the plan is saved as `plans/<task>-<n>.md`, the task becomes
  `planning`, and the lead gets a message with the subject, the plan's path
  and its first lines.
- **Waiting** depends on the `plan_approval` setting (per team, overridable
  per member or task):

  | `plan_approval` | Teammate is told to | Lead |
  |---|---|---|
  | `lead` (default) | submit, then **stop and wait** for a reply | reviews, then `plan approve` or `plan reject --feedback "…"` |
  | `none` | submit, then **continue** | reads it for awareness; steps in with an ordinary message if needed |

- **Verdict:** `plan approve <task>` and `plan reject <task> --feedback "…"`
  record the verdict, set the status (`in_progress` or back to `planning`),
  and send the teammate a message. The waiting teammate receives it as soon
  as it is idle.
- A verdict that arrives after the teammate has already moved on is still
  recorded and delivered.

## 9. Quality gates

### 9.1 Hooks

Hooks are executables in `.herdr/teams/hooks/` (project) or
`~/.config/herdr-teams/hooks/` (global), named after the event:

| Hook | Runs | Exit 2 means |
|---|---|---|
| `task_created` | before a task is stored | reject the task; stderr goes to the creator |
| `task_completed` | before a task becomes `completed` | **reject the completion**: the task stays `in_progress` and stderr becomes the owner's next prompt |
| `teammate_idle` | when a teammate goes idle | keep it working; stderr becomes its next prompt |
| `plan_submitted` | before the lead is notified of a plan | reject the plan with stderr as feedback |

- **Exit 0** lets the action proceed.
- **Any other exit code** is a hook failure, handled by the failure policy
  (§9.3).

Each hook receives the event as JSON on stdin, plus the environment variables
`HERDR_TEAMS_EVENT`, `HERDR_TEAMS_TEAM`, `HERDR_TEAMS_AGENT`,
`HERDR_TEAMS_TASK_ID` and `HERDR_TEAMS_TASK_JSON`. It runs in the task's
worktree (or the shared checkout), with a timeout that defaults to 10 minutes.

For compatibility, an existing `.pi/team-hooks/task_completed.sh` is also
run, using its original calling convention.

### 9.2 Per-task gates

A task can carry `gate: "<command>"`, for example `npm test`. It runs before
the `task_completed` hook, has the same exit-code meaning, and runs in the
task's worktree.

### 9.3 Failure policy

This is a team setting (`hooks:` in the template):

| Setting | Values | Default |
|---|---|---|
| `failure_action` | `warn`, `reopen`, `followup`, `reopen_followup` | `warn` |
| `max_reopens` | integer (0 disables auto-reopen) | `3` |
| `followup_owner` | `member`, `lead`, `none` | `member` |

## 10. Git worktrees

Worktrees give parallel writers isolated checkouts. They isolate files, not
processes or permissions.

### 10.1 Modes

Set per teammate (in the agent definition, template or spawn flags); a task
can additionally require one:

| Mode | Behaviour |
|---|---|
| `shared` | works in the lead's checkout; suited to read-only or single-writer work |
| `dedicated` | gets its own worktree at spawn |
| `auto` | starts shared; gets a worktree when it claims a task marked `worktree: required`, or when the lead approves its request |

### 10.2 Ownership

The lead manages worktrees:

- `herdr-teams worktree create <member|task> [--branch B] [--base REF]`.
- A teammate can ask with `herdr-teams worktree request --reason "…"`. The
  request goes to the lead, who runs `herdr-teams worktree approve <id>`.
  The team setting `worktree_requests: auto` approves requests immediately.

### 10.3 Creation

1. Resolve the base to an exact commit (default: the lead's `HEAD`).
   Uncommitted changes in the lead's checkout are not carried over, and the
   lead is warned.
2. Name the branch `team/<team>/<member>[-<task>]`. Existing branches are
   refused.
3. Run `herdr worktree create --cwd <repo> --branch <b> --base <sha>
   --label "<team>:<member>" --no-focus`. This creates the checkout and
   opens it as a herdr workspace grouped with the repository.
4. A new teammate starts in the workspace's root pane. An existing one is
   moved there with `herdr pane move`, which keeps its session.
5. Record the path, branch and base commit on the member and the task.

### 10.4 Completion report

When a task finishes in a worktree, the lead's report includes the path,
branch, base and head commits, commits ahead, changed files, and whether the
checkout is clean, dirty or conflicted.

### 10.5 Integration and cleanup

- `worktree status [member]`, `worktree diff <member>`.
- `worktree merge <member> [--into <branch>] [--squash]` merges locally, only
  when the lead runs it. It stops and reports on conflicts.
- The plugin **never** pushes, opens pull requests or merges on its own.
- `worktree remove <member> [--preserve]` is refused unless:
  - the checkout is clean, or `--preserve` first makes a WIP commit;
  - no agent is running in the worktree;
  - the branch is merged, or `--force-unmerged` is given.

  Branches are kept unless `--delete-branch` is given.

## 11. Live supervision

### 11.1 Member states

herdr's agent state (`idle`, `working`, `blocked`, `done`, `unknown`) is the
authority for what a teammate is doing. Every state change is logged with a
timestamp, so "working 12m" or "blocked 3m" can be shown without polling.
herdr's `completion_seq` distinguishes a finished turn from start-up or
restored idle.

| State | Meaning |
|---|---|
| `starting` | being launched; `agent start` hasn't returned |
| `working` / `idle` / `blocked` | as reported by herdr |
| `waiting-plan` | idle after submitting a plan, with `plan_approval: lead` |
| `interrupted` | its turn was interrupted and it hasn't started a new one |
| `stalled` | a no-progress advisory is active (§11.3) |
| *end state* | one of §11.2 |

### 11.2 End states

Every teammate ends in exactly one end state, reported once to the lead:

| End state | Evidence | Report includes |
|---|---|---|
| `shut-down` | shutdown accepted, then the agent exited | summary |
| `closed-by-user` | pane or agent closed with no handshake, after a human focused it | last output |
| `failed-to-launch` | `agent start` failed, or the agent exited during start-up | launch arguments, last output |
| `crashed` | the agent exited or vanished later | last output, session reference for resuming |
| `killed` | `herdr-teams kill` | — |

Exits are detected from events: the agent disappearing from its pane,
`pane.exited` or `pane.closed`. A teammate that has exited is never reported
as stalled.

### 11.3 Stall advisories

A stall means **no progress**, not a long run time. Progress evidence is:

1. a herdr state change;
2. team activity by the member: a `herdr-teams` call, a message or a task
   update;
3. a screen change. The supervisor periodically hashes the last 40 lines of
   output; spinner-only changes don't count.

| Advisory | Condition | Default |
|---|---|---|
| `no-progress` | `working` with no progress evidence | 10 min |
| `needs-input` | `blocked` on a permission or question prompt | 2 min |
| `unclassified` | herdr state `unknown` | 5 min |

- Each advisory goes to the lead once per episode, followed by a `recovered`
  notice when progress resumes. It describes what was observed and suggests
  peek, nudge, interrupt or kill.
- `needs-input` also raises a herdr notification, because a human should
  answer permission prompts, not the lead.
- **Interactive members stay quiet:** if a human recently focused the
  member's pane, or the member is marked `interactive: true`, advisories
  appear only on the board.
- With `on_no_progress: nudge`, the supervisor first sends the teammate one
  status-check prompt, and tells the lead only if it doesn't help.

### 11.4 Correcting a running teammate

From gentlest to strongest:

| Action | CLI | Board key | What happens | Conversation |
|---|---|---|---|---|
| Peek | `peek <name> [--lines N]` | `enter` | shows recent output | — |
| Message | `msg send <name> "…"` | `m` | delivered when idle | kept |
| Steer / urgent | `steer <name> "…"` or `msg send --urgent` | `u` | delivered while working | kept |
| Interrupt | `interrupt <name> [--then "…"]` | `i` | sends Esc to cancel the turn; optionally prompts once idle | **kept** |
| Release task | `task release <id> [--reason "…"]` | `r` | interrupt, return the task to `pending`, tell the owner why | kept |
| Kill | `kill <name>` | `x` | closes the pane; tasks return to `pending` | lost |

**Steering** uses the agent CLI's own mid-turn input where it works safely.
Otherwise it falls back to interrupt-then-prompt (§13). Nothing is ever typed
into a `blocked` agent.

**Authority:** only the lead or the user may steer, send urgent messages,
interrupt, release or kill another member; urgent delivery can press Esc in
the recipient's pane.

### 11.5 The supervisor

Time-based checks need a long-running process, and herdr plugins run those
in panes. Each team therefore has one supervisor, `herdr-teams supervise`, in
a plugin pane with a one-line status (`supervisor · 3 members · 1 advisory`).

- **Events:** it subscribes over herdr's socket to
  `pane.agent_status_changed`, `pane.exited`, `pane.closed`, `pane.moved` and
  `pane.focused` for member panes. If herdr reports `events_lost`, it
  resubscribes and reconciles from a fresh `session.snapshot`.
- **Clock:** every `tick_seconds` (default 30) it checks advisories, samples
  screens and flushes waiting mail.
- **Configuration:** a team setting that is on by default and included in
  every example template (§14.2):

  | `supervisor.mode` | Behaviour |
  |---|---|
  | `pane` (default) | a narrow pane in the team tab |
  | `tab` | its own `team:<team>:system` tab, keeping the team tab agents-only |
  | `off` | no supervisor: delivery and state tracking run through the event hooks, and there are no stall advisories |

- **Resilience:** if the supervisor pane is closed, delivery and state
  tracking continue through the event hooks; only stall advisories pause, and
  the board shows "supervisor offline". `herdr-teams supervise --team <t>`
  reopens it, and the startup hook reopens it after a herdr restart.

## 12. Board and observability

- **Board pane** (`herdr-teams board`): a live task board with a column per
  status. It shows owners, dependencies, branches, unread counts and recent
  messages. A member strip shows each member's state, time in state and
  advisories (`⚠ no-progress 12m`, `✋ needs-input`). Keys: the §11.4 actions,
  plus assign, reopen, and plan approve or reject. The board only reads the
  team's files, so it can be opened and closed freely.
- **herdr sidebar:** each member's pane shows a display name, a state label
  (e.g. "#12 rate limiter") and tokens (`$task`, `$team`, `$branch`,
  `$advice`). The team's workspace shows a summary token
  (`$team_status = "3/7 done · 1 stalled"`).
- **`herdr-teams status [name]`:** the same information as text or JSON, for
  the lead.
- **`herdr-teams log [--follow]`:** the event log as an audit trail.

## 13. Agent adapters

Each adapter maps the shared settings onto one agent CLI. v1 includes
`claude`, `codex` and `pi`, with `opencode` next. Thinking levels are
normalized to `off | minimal | low | medium | high | xhigh` and mapped to each
CLI's nearest value.

| Concern | claude | codex | pi |
|---|---|---|---|
| model | `--model <m>` | `-m <m>` | `--model <provider/m>` |
| thinking | effort setting | `-c model_reasoning_effort=<lvl>` | `--thinking <lvl>` |
| extra instructions | `--append-system-prompt` | instructions file / `AGENTS.md` | `--append-system-prompt` |
| exit | `/exit` | `/quit` | `/quit` |
| interrupt turn | `esc` | `esc` | `esc` |
| steering | mid-turn prompt | Enter steers, Tab queues | native steer queue |

All flags and keys must be verified against current CLI versions while
implementing (§18).

## 14. Configuration

### 14.1 Locations

| What | Project | Global |
|---|---|---|
| Templates | `.herdr/teams.yaml` | `~/.config/herdr-teams/teams.yaml` |
| Agent definitions | `.herdr/agents/*.md` | `~/.config/herdr-teams/agents/*.md` |
| Hooks | `.herdr/teams/hooks/` | `~/.config/herdr-teams/hooks/` |
| Runtime state | — | `$HERDR_TEAMS_HOME` (default: herdr's plugin state dir) |

Agent definitions are also read from `.pi/agents/` and `.claude/agents/`, so
existing pi and Claude Code definitions work unchanged. Project files take
precedence over global ones, and `.herdr/` over the compatibility folders.

### 14.2 `teams.yaml`

The pi-teams short form (a list of agent names) is accepted. The full form:

```yaml
plan-build:                     # short form
  - planner
  - builder
  - reviewer

auth-squad:
  description: Rework authentication
  lead: { kind: claude, model: opus }
  defaults: { kind: claude, thinking: medium, worktree: auto, auto_claim: true }
  plan_approval: lead           # lead | none
  worktree_requests: lead       # lead | auto
  hooks:
    failure_action: reopen_followup
    max_reopens: 2
    followup_owner: member
  supervisor:
    mode: pane                  # pane | tab | off
    tick_seconds: 30
    no_progress_minutes: 10     # 0 disables an advisory
    needs_input_minutes: 2
    unknown_minutes: 5
    on_no_progress: notify      # notify | nudge
  members:
    - name: alice
      agent: builder
      worktree: dedicated
    - name: bob
      agent: reviewer
      kind: codex
      plan_mode: false
  tasks:                        # optional seed tasks
    - subject: Map the current auth flow
      owner: bob
```

### 14.3 Agent definitions

```markdown
---
name: reviewer
description: Reviews diffs for correctness and security
kind: codex             # agent CLI (default: team default, then the lead's)
model: gpt-5.4
thinking: high
plan_mode: false
worktree: shared        # shared | dedicated | auto
auto_claim: true
interactive: false      # true: advisories go to the board only
tools: read, bash       # advisory; applied where the CLI supports it
---
Review changes only. Report findings with file:line references ...
```

Unknown frontmatter keys are ignored.

## 15. CLI reference

| Group | Commands |
|---|---|
| Team | `team create`, `team start <template>`, `team save <template>`, `team list`, `status [name]`, `done`, `cleanup`, `log` |
| Members | `spawn`, `shutdown [--accept\|--reject]`, `kill`, `peek`, `steer`, `interrupt` |
| Tasks | `task add`, `task list`, `task show`, `task claim`, `task assign`, `task release`, `task update`, `task complete`, `task dep add\|rm` |
| Messages | `msg send [--urgent]`, `broadcast`, `report`, `inbox` |
| Plans | `plan submit`, `plan approve`, `plan reject` |
| Worktrees | `worktree create\|request\|approve\|status\|diff\|merge\|remove` |
| Panes | `board`, `supervise` |

Every command accepts `--team` (defaulting to `HERDR_TEAMS_TEAM`) and `--json`.

## 16. Plugin manifest

```toml
id = "herdr-teams"
name = "herdr teams"
version = "0.1.0"
min_herdr_version = "0.9.0"
platforms = ["linux", "macos"]

[[build]]
command = ["npm", "ci"]
[[build]]
command = ["npm", "run", "build"]

[[startup]]                          # reconcile and reopen supervisors after restart
command = ["node", "dist/bin/herdr-teams.js", "_hook", "startup"]

[[events]]                           # fallback path when no supervisor runs
on = "pane.agent_status_changed"
command = ["node", "dist/bin/herdr-teams.js", "_hook", "event"]
[[events]]
on = "pane.exited"
command = ["node", "dist/bin/herdr-teams.js", "_hook", "event"]
[[events]]
on = "pane.closed"
command = ["node", "dist/bin/herdr-teams.js", "_hook", "event"]
[[events]]
on = "pane.moved"
command = ["node", "dist/bin/herdr-teams.js", "_hook", "event"]

[[actions]]
id = "start-team"
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
id = "supervisor"
title = "Team supervisor"
placement = "split"
command = ["node", "dist/bin/herdr-teams.js", "supervise"]
```

Spawned panes get `$HERDR_PLUGIN_ROOT/bin` prepended to `PATH`, so every
teammate can run `herdr-teams`. herdr puts nothing on the lead's `PATH`; the
`install-shim` action links the CLI into `~/.local/bin`.

## 17. Milestones and testing

### 17.1 Milestones

| # | Deliverable | Done when |
|---|---|---|
| M0 | Project skeleton: TypeScript, lint, tests, manifest, herdr wrapper, fake herdr for tests | `herdr plugin link .` succeeds; CI green |
| M1 | Core store: teams, tasks with dependencies and claim locking, inboxes, event log; CLI `team`, `task`, `msg` | 20 concurrent claimers: exactly one wins |
| M2 | Spawning and lifecycle: layout, `agent start`, claude/codex/pi adapters, labels, bootstrap, shutdown, kill, done, launch-failure reports | A Claude lead spawns Codex and pi teammates in a real herdr session |
| M3 | Delivery: event hooks, batched delivery, reports to the lead, auto-claim, reconciliation | An idle teammate receives a message within ~1 s, with no polling |
| M4 | Supervision: supervisor pane, state log, end states, advisories, peek, steer, interrupt, release | A frozen test agent produces exactly one advisory and one `recovered`; an interrupted teammate continues with its context |
| M5 | Worktrees: modes, requests, creation and move, completion report, status/diff/merge, guarded removal, cleanup | Two writers in parallel worktrees; the lead merges both |
| M6 | Plan mode and quality gates: plan submit/approve/reject, hooks with exit-2 semantics, per-task gates, failure policy | A failing `npm test` gate keeps the task open and tells the owner why |
| M7 | Templates and definitions: `teams.yaml`, agent definitions, `team start`, `team save` | Save a team, start it again, get the same team |
| M8 | Board pane and sidebar labels | The board works as the only control surface |
| M9 | MCP front-end, more adapters, Windows check, docs, marketplace listing | Installable with `herdr plugin install sonhal/herdr-teams` |

### 17.2 Testing

- **Unit tests:** store, dependency graph, locking, settings resolution,
  adapter arguments.
- **Contract tests:** against the fake herdr, checking which commands are
  called with which arguments, using response JSON from herdr's API schema.
- **End-to-end:** a scripted run in a real herdr session with a stand-in
  "echo agent" (a shell script that reports its state to herdr). No API keys
  needed.

## 18. Open questions and risks

1. **Steering safety.** Check per CLI and version that a prompt typed during
   a turn is steered or queued safely, and can't land in a tool-approval
   dialog. Use interrupt-then-prompt where it isn't safe. (M4)
2. **Detecting agent exit.** When an agent exits, its pane falls back to the
   shell and `pane.exited` doesn't fire. Confirm that herdr emits a usable
   event when the agent disappears; otherwise detect it with `agent get` on
   the supervisor tick. (M2)
3. **Launch robustness.** Test `agent start` against a slow shell rc,
   direnv, and a bad `--model`, to make sure failures are reported rather than
   silent. (M2)
4. **Stall false positives.** Long silent builds or test runs look like no
   progress. Mitigated by generous defaults, team-activity evidence, and
   advisories never acting on their own. Revisit after real use.
5. **Event-hook cost.** Without a supervisor, each state change starts a
   Node process. Measure it; if needed, exit early when the pane isn't a team
   member.
6. **Prompt injection between agents.** Message bodies are untrusted and
   marked as such. State changes such as approvals only come from real
   commands with the right identity.

---

## Appendix A: herdr primer for implementers

Summary of the herdr features this plan relies on, based on herdr **v0.9.5**.
The authoritative sources are the upstream repository
[`ogulcancelik/herdr`](https://github.com/ogulcancelik/herdr): docs under
`docs/preview/website/src/content/docs/` (`plugins.mdx`, `cli-reference.mdx`,
`socket-api.mdx`, `agent-automation.mdx`, `agents.mdx`) and the API schema
under `src/api/schema/`. `herdr --skill` prints the agent skill bundled with
the installed binary. Check these before relying on a detail below.

### Concepts

- **Session → workspace → tab → pane.** A workspace is a project container,
  a tab is a layout inside it, and a pane is a real terminal. A background
  server owns the panes, so they survive a client detaching.
- **Agent:** a recognized coding-agent process inside a pane. herdr detects
  it from the foreground process and screen manifests, or from the agent's
  own state reports.
- **Pane IDs** look like `w1:p2`. A pane moved to another workspace gets a
  new ID: use `.result.move_result.pane.pane_id` afterwards. The old ID stays
  valid as an alias for the running process.
- Inside a herdr pane, `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_TAB_ID` and
  `HERDR_WORKSPACE_ID` are set.

### Plugins

- **Plugin = manifest + commands.** A plugin is a directory with
  `herdr-plugin.toml`. It declares `[[build]]`, `[[startup]]`, `[[actions]]`,
  `[[events]]`, `[[panes]]` and `[[link_handlers]]`. Each entry is an argv
  command (not run through a shell) in any language. *"The entire herdr CLI
  is the plugin API"*: commands call back through `$HERDR_BIN_PATH`.
- Required manifest fields: `id`, `name`, `version`, `min_herdr_version`.
  Declare `platforms`.
- **Injected env:** `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_ENV=1`,
  `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`,
  `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_CONTEXT_JSON`, and the
  `HERDR_WORKSPACE_ID` / `HERDR_TAB_ID` / `HERDR_PANE_ID` of the current
  context. Event hooks also get `HERDR_PLUGIN_EVENT` and
  `HERDR_PLUGIN_EVENT_JSON`; actions get `HERDR_PLUGIN_ACTION_ID`; panes get
  `HERDR_PLUGIN_ENTRYPOINT_ID`.
- Runtime commands run with the plugin directory as their working directory.
  Don't keep state in `HERDR_PLUGIN_ROOT`; use `HERDR_PLUGIN_STATE_DIR` and
  `HERDR_PLUGIN_CONFIG_DIR`.
- **Hookable events** (`PLUGIN_HOOK_EVENT_KINDS` in
  `src/api/schema/events.rs`) include **`pane.agent_status_changed`**,
  `pane.agent_detected`, `pane.exited`, `pane.closed`, `pane.moved`,
  `pane.focused`, `pane.created` and `worktree.created` /
  `worktree.removed`. High-volume events such as `pane.output_changed` and
  `layout.updated` are not hookable.
- **No storage API, no supervised daemons.** Startup hooks are one-shot. The
  plugin owns its files. Detached background processes must be stopped before
  their parent command or pane exits.
- **Plugin panes:** `[[panes]]` with
  `placement = split|tab|popup|overlay|zoomed`. Opened with
  `herdr plugin pane open --plugin <id> --entrypoint <pane> [--placement …]
  [--env K=V]`. Split, tab and zoomed plugin panes are normal herdr panes.
- **Developing:** `herdr plugin link <dir>` registers a local checkout (no
  build step runs). `herdr plugin action invoke <id.action>`,
  `herdr plugin log list --plugin <id>` and `herdr plugin list` help with
  debugging. `herdr plugin install owner/repo[/subdir]` installs from GitHub
  and runs `[[build]]`.

### Layout and worktrees

- `herdr workspace create`, `herdr tab create` and
  `herdr pane split --direction right|down --cwd --env K=V --no-focus`. Each
  returns JSON with the new IDs (`.result.root_pane.pane_id`,
  `.result.pane.pane_id`). Creation never steals focus unless `--focus` is
  given.
- `herdr pane move <id> --tab|--new-tab|--new-workspace`,
  `herdr pane close <id>`.
- **Worktrees:** `herdr worktree create --cwd <repo> --branch <b> --base <ref>
  --label <l> --no-focus` creates the git worktree **and** opens it as a
  herdr workspace grouped with the repo. `herdr worktree remove --workspace
  <id> [--force]` runs `git worktree remove` and never deletes branches.

### Agents

- **Start:** `herdr agent start <name> --kind <kind> --pane <id>
  [--timeout ms] -- <args>`. The pane must be at an idle shell prompt. It
  supports `claude`, `codex`, `pi`, `opencode`, `gemini`, `copilot`,
  `cursor`, `amp`, `droid` and others (about 24 kinds). It returns only once
  the agent is ready (default timeout 30 s); it returns `agent_not_ready` if
  the agent is `blocked` during start-up. Names follow
  `[a-z][a-z0-9_-]{0,31}`, are unique among live agents, and are cleared when
  the agent exits.
- **Driving agents:** `agent prompt <name> "<text>" [--wait --until idle]`,
  `agent wait`, `agent read --source recent-unwrapped --lines N` and
  `agent send-keys <name> esc`. `agent prompt` refuses to type into an agent
  that is `blocked` (returns `agent_blocked`), which is a useful safety
  property. `--wait` returns `agent_prompt_stalled` if no activity is seen
  within 5 s, and it tracks state, not individual turns. A timeout doesn't
  prove nothing was sent, so read the agent before retrying.
- **State model:** `idle`, `working`, `blocked`, `done` and `unknown`. herdr
  detects it from the screen or from integrations, and it rolls up to the
  sidebar. `idle` and `done` both mean ready for input. `completion_seq`
  marks an idle transition that completed real work. `agent get` and
  `agent list` also expose `agent_session` (for resume) and
  `foreground_cwd`.
- **Display:** `pane report-metadata --source herdr-teams --title ...
  --display-agent "alice · reviewer" --token task=#12` sets the sidebar label
  without taking over semantic state. Tokens are limited to 16 per report and
  32 per pane, with values up to 80 characters. `workspace report-metadata`
  does the same for workspaces.

### Socket API and events

- Newline-delimited JSON over a Unix socket (`HERDR_SOCKET_PATH`); the CLI is
  a thin wrapper over it. CLI errors print JSON to stderr and exit 1; bad
  CLI syntax exits 2.
- `events.subscribe` keeps a connection open and pushes events. Event
  history isn't durable. A slow subscriber gets `events_lost` and is
  disconnected; recover by resubscribing and reconciling from
  `session.snapshot`.
- Subscription-only event kinds include `pane.output_matched` and
  `pane.scroll_changed`.

## Appendix B: Influences

| Project | Ideas adopted |
|---|---|
| [burggraf/pi-teams](https://github.com/burggraf/pi-teams) | Overall shape: lead plus named teammates in panes, task board, inboxes, plan submission, `teams.yaml`, markdown agent definitions, saving a team as a template, task-completed hook |
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) | Task dependencies that unblock automatically; locked claiming; pushed delivery; idle reports carrying the teammate's answer; hooks where exit 2 rejects with feedback; shutdown handshake; messages marked as not from the user |
| [tmustier/pi-agent-teams](https://github.com/tmustier/pi-agent-teams) | Auto-claim; urgent messages that steer a working agent; hook failure policy; time-in-state and stall display; per-teammate worktrees and cleanup |
| [giuseppecrj/pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) | herdr layout (agent tab, 4 per tab, no focus stealing); worktree contract and completion report; never push or merge; guarded removal; no-progress advisories once per episode; interrupt with Esc keeping the session; quiet interactive agents |
| [modem-dev/pi-herdr-subagents](https://github.com/modem-dev/pi-herdr-subagents) | Exactly one honest end state per agent; launch-failure reports with output; long-lived event subscriber |
| [dantetekanem/pi-extended-teams](https://github.com/dantetekanem/pi-extended-teams) | Single-key message, interrupt and stop on a running agent |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | Per-task acceptance gate command |
