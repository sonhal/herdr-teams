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

Requires Node.js ≥ 20 and npm. M0 is a skeleton: commands print “not
implemented”; hooks, actions, board, and supervisor stubs log and exit 0.

```sh
npm ci
npm run build
npm test
npm run lint
npm run typecheck
./bin/herdr-teams --help
./bin/herdr-teams --team demo --json status
```

With herdr ≥ 0.9 installed, build first, then run:

```sh
herdr plugin link .
herdr plugin action invoke herdr-teams.start-team
```

Linking does not build. Invoking an action requires a running herdr session.
The shim at `bin/herdr-teams` loads `dist/bin/herdr-teams.js`. Tests use a
scripted fake herdr executable; no agents or API keys are needed.
