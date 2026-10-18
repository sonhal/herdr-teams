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
dependencies and exclusive claiming, inboxes, and an event log. Agent lifecycle,
delivery, hooks, board, and supervisor remain placeholders.

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
Messages are persisted for delivery in M3. Generated state belongs outside the
repository or in an ignored directory.
