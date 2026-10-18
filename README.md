# herdr-teams

![header](static/herdr-teams.png)

> ⚠️ **Work in progress.** Not ready for use.

A [herdr](https://github.com/ogulcancelik/herdr) plugin for running a team of
coding agents. A lead agent spawns persistent, named teammates (Claude Code,
Codex, pi, …), each in its own herdr pane with its own model and thinking level.

- **Task board:** a shared board with statuses and dependencies.
- **Inboxes:** direct messages, broadcasts and reports to the lead, delivered
  when an agent is idle.
- **Git worktrees:** isolated checkouts for parallel work, managed by the lead.
- **Plan mode and quality gates:** plans before code, and hooks that can reject
  a task's completion.
- **Live supervision:** stall warnings, plus steering, interrupting or stopping
  a running agent.

See [docs/PLAN.md](docs/PLAN.md) for the design.

## Development

Requires Node.js ≥ 20 and npm. M1 implements persistent teams, tasks with
dependencies and exclusive claiming, inboxes, and an event log. M2 adds spawning, labels, bootstrap, shutdown and kill. M3 adds idle inbox
delivery, event hooks, turn reports, auto-claim and restart reconciliation.
M4 adds the supervisor, progress advisories and correction commands. The board
remains a placeholder.

```sh
npm ci
npm run build
npm test
npm run lint
npm run typecheck
./bin/herdr-teams --help
./bin/herdr-teams --team demo --json task list
```

With herdr ≥ 0.9 installed, build first, then run:

```sh
herdr plugin link .
herdr plugin action invoke herdr-teams.start-team
```

Linking does not build. Invoking an action requires a running herdr session.
The shim at `bin/herdr-teams` loads `dist/bin/herdr-teams.js`. Tests use a
scripted fake herdr executable; no agents or API keys are needed.

## Core CLI

```sh
export HERDR_TEAMS_HOME="$PWD/.teams-state"
./bin/herdr-teams team create demo --lead lead
export HERDR_TEAMS_TEAM=demo
./bin/herdr-teams task add "Implement authentication" --description "Add login"
./bin/herdr-teams task claim 1
./bin/herdr-teams task complete 1 --result "Login implemented"
./bin/herdr-teams msg send lead "Ready for review"
./bin/herdr-teams inbox
```

`task dep add <task> <prerequisite>` blocks claims until the prerequisite is
completed. `task assign`, `task release`, dependency edits and task edits are
restricted to the lead or a user outside a member pane. `task update` accepts
`--subject` and `--description`; `task complete` accepts `--result`.
`team list`, `task list`, `task show`, `broadcast` and `report` are also available.
Core commands currently print JSON, including when `--json` is omitted.
Messages are persisted and delivered in batches when recipients are idle.
Blocked recipients retain their mail. `--urgent` mail steers a working Codex
agent; other kinds use interrupt-then-idle delivery. Set `auto_claim: false` in team config
to disable automatic claiming. Generated state belongs outside the repository
or in an ignored directory.

## Teammates

Inside a herdr session, create a team from the lead pane, then spawn members:

```sh
herdr-teams team create demo
herdr-teams --team demo spawn alice --kind codex --thinking high --prompt "Review the implementation"
herdr-teams --team demo shutdown alice
```

Members receive team identity and the CLI on PATH. Splits use team tabs with
four teammates per tab; `--placement tab|workspace` gives a member its own
location. All panes open without taking focus. `--model` and `--thinking`
override team defaults. Dedicated worktrees await M5.

A shutdown request waits for the member to accept or reject it. Accepted requests
exit the CLI when idle and close the pane only after exit is observed. `done`
requests shutdown for all teammates, refusing active tasks; `done --force` and
`kill <name>` close panes and return active tasks to pending. Launch failures
retain the pane and send the lead arguments and recent output.

## Supervision

The supervisor opens after team creation and reopens on herdr startup. Set
`supervisor.mode` to `off` to use event hooks alone, or `tab` for a separate
system tab. Defaults are a 30-second tick, a 10-minute no-progress advisory,
a 2-minute needs-input advisory and a 5-minute unknown-state advisory. Set a
threshold to zero to disable it. Advisories inform the lead; they do not kill
or restart teammates. Interactive or recently focused members stay quiet.

```sh
herdr-teams --team demo peek alice --lines 40
herdr-teams --team demo steer alice "Focus on the failing test"
herdr-teams --team demo interrupt alice --then "Summarize your current work"
herdr-teams --team demo task release 1 --reason "Reassigning the task"
```

Only the lead or user may interrupt, release or kill. Blocked agents must have
their permission or question prompt answered before those input operations.
