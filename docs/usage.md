# Usage reference

[Back to the README](../README.md)

## Core CLI

```sh
export HERDR_TEAMS_HOME="$PWD/.teams-state"
./bin/herdr-teams team create demo --lead lead
export HERDR_TEAMS_TEAM="<id returned by team create>"
./bin/herdr-teams task add "Implement authentication" --description "Add login"
./bin/herdr-teams task claim 1
./bin/herdr-teams task complete 1 --result "Login implemented"
./bin/herdr-teams msg send lead "Ready for review"
./bin/herdr-teams inbox
```

`team create` and `team start` return an instance UUID in `id` and a display
`name`. Select the UUID with `HERDR_TEAMS_TEAM` or `--team`; a display name also
works when it identifies exactly one team in the state directory. Multiple
instances may share a name, so use their IDs when names are ambiguous.

`task dep add <task> <prerequisite>` blocks claims until the prerequisite is
completed. `task assign`, `task release`, dependency edits and task edits are
restricted to the lead or a user outside a member pane. `task update` accepts
`--subject` and `--description`; `task complete` accepts `--result`.
`team list`, `task list`, `task show`, `broadcast` and `report` are also available.
`inbox` prints mail not yet delivered to the caller's pane; `inbox --all`
prints the full history. Completing a task tells the lead its result.
Commands print compact text, such as one line per task; `--json` prints the
full records.
Messages are persisted and delivered in batches when recipients are idle.
Blocked recipients retain their mail. A message body is limited to 32 KiB;
send a file path for anything larger. Large backlogs arrive over several
prompts. Only the lead or user may send `--urgent` mail, which steers a working
Codex agent; other kinds use interrupt-then-idle delivery. Set `auto_claim: false` in team config
to disable automatic claiming. Generated state belongs outside the repository
or in an ignored directory.

## Teammates

herdr does not put plugin commands on PATH, so install the CLI for the lead once
(see [Installation details and support](#installation-details-and-support)). Inside a herdr
session, create a team from the lead pane, then spawn members:

```sh
herdr plugin action invoke herdr-teams.install-shim
herdr-teams team create demo
herdr-teams --team demo spawn alice --kind codex --thinking high --prompt "Review the implementation"
herdr-teams --team demo shutdown alice
```

Inside herdr, team state defaults to herdr's plugin state directory, the one
its startup and event hooks read; leave `HERDR_TEAMS_HOME` unset there. A team
belongs to the herdr session it was created in: commands and hooks from other
sessions leave it alone. A pane leads at most one active team in a session:
`team create`, `team start` and `spawn` refuse while another team led from that
pane has running teammates. Members receive team identity and the CLI on PATH. Splits put the first
four teammates beside the lead in its tab, then in team tabs of four;
`--placement tab|workspace` gives a member its own
location. All panes open without taking focus. Each member's pane, and the
lead's while teammates run, reports the member name as its agent label; set
`show_agent_labels_on_pane_borders = true` under `[ui]` in herdr's config to
show it on split pane borders. `--model` and `--thinking`
override team defaults. Teammates share the lead's checkout; `--worktree dedicated` gives one an isolated checkout.
In herdr, a new teammate's agent name includes a four-character suffix derived
from its instance ID and member name. The readable `<team>-<member>` prefix is
trimmed to 27 characters so the full name fits in 32. Use the member name in herdr-teams commands;
the stored herdr agent name is handled automatically.

A shutdown request waits for the member to accept or reject it. Accepted requests
exit the CLI when idle and close the pane only after exit is observed. `done`
accepts shutdown for all teammates the same way, refusing active tasks; `done --force` and
`kill <name>` close panes and return active tasks to pending. Launch failures
retain the pane for `peek` and send the lead the arguments and error.

## Team control

Event hooks deliver waiting mail and completion reports, track member exits,
and update sidebar labels. The lead decides when to inspect or correct progress.
There is no background clock or automatic stall detection. Scheduled wakeups
are tracked in [issue #32](https://github.com/sonhal/herdr-teams/issues/32).
Remove the old `supervisor` block from team templates; it is no longer supported.

```sh
herdr-teams --team demo peek alice --lines 40
herdr-teams --team demo steer alice "Focus on the failing test"
herdr-teams --team demo interrupt alice --then "Summarize your current work"
herdr-teams --team demo task release 1 --reason "Reassigning the task"
```

Only the lead or user may steer, interrupt, release or kill. Blocked agents must have
their permission or question prompt answered before those input operations.

## Worktrees

Teammates share the lead's checkout by default, which suits research, review
and work on separate files. A teammate spawned with `--worktree dedicated` gets
its own branch and checkout in a new workspace:

```sh
herdr-teams --team demo spawn alice --worktree dedicated --prompt "…"
herdr-teams --team demo worktree status alice
herdr-teams --team demo worktree diff alice
herdr-teams --team demo worktree merge alice
herdr-teams --team demo worktree remove alice
```

The worktree starts from the lead's last commit; uncommitted changes in the
lead checkout stay there, and `spawn` warns about them on stderr. Only the lead or user merges and removes worktrees.

Completion reports include branch, base, head, commit count and checkout state.
Merge requires clean checkouts and runs only on an explicit command. Removal
requires no running agent, a clean checkout and a branch merged into the lead's
HEAD. `--preserve` commits dirty files first, `--force-unmerged` keeps an unmerged
branch, and `--delete-branch` explicitly removes the branch. `cleanup` lists
ended members' worktrees; `cleanup --apply` removes only eligible ones.

## Plans and quality gates

```sh
herdr-teams --team demo task add "Implement login" --plan-mode --gate "npm test"
herdr-teams --team demo plan submit 1 --file plan.md
herdr-teams --team demo plan approve 1
herdr-teams --team demo plan reject 1 --feedback "Add failure tests"
```

The active owner submits a versioned plan; only the lead or user approves or
rejects it. `plan_approval: none` lets the owner continue after submitting.
Late verdicts are recorded without reopening terminal tasks.

Executable hooks in `.herdr/teams/hooks/` override global hooks in
`~/.config/herdr-teams/hooks/`. Names are `task_created`, `task_completed`,
`plan_submitted` and `teammate_idle`. They receive JSON on stdin and team,
member and task identity in `HERDR_TEAMS_*` variables. Completion gates run
first, in the owner's worktree if it has one. Exit 2 rejects an action with
feedback; any other failure also keeps the task open and warns the lead. Hook
timeouts default to 600 seconds.
Existing `.pi/team-hooks/task_completed.sh` hooks also run with JSON as their
first argument and `PI_TEAM` set.

## Templates and agent definitions

herdr-teams ships two templates. `dev` has a developer (plans
before coding), a reviewer and a tester; `research` has two researchers who
write `research/<task>.md` and a synthesizer who merges them into
`research/report.md`. `team templates` lists every template and where it comes
from. An instance is named after its template plus the start of its ID, such
as `dev-3f2a`, unless `--name` sets one; teammates' pane labels are their member
names.

```sh
herdr-teams team templates
herdr-teams team start dev --name app
```

A member's agent CLI comes from `spawn --kind`, then its role or template,
then `team start --kind`, then the agent running in the pane that started it.
The built-in templates name none, so a Claude lead gets Claude teammates. From
a plain shell, or when that agent cannot be launched, pass `--kind` (`claude`,
`codex`, `pi` or `opencode`).

Put reusable roles in `.herdr/agents/<name>.md` with YAML frontmatter and a
markdown instruction body. Project `.herdr/` definitions take precedence over
`.pi/agents/`, `.claude/agents/`, global definitions in
`~/.config/herdr-teams/agents/` and the built-in roles.

```yaml
---
kind: codex
thinking: high
worktree: shared
---
Review changes and report defects with file and line references.
```

Define teams in `.herdr/teams.yaml` or `~/.config/herdr-teams/teams.yaml`; a
template with a built-in name replaces the built-in one:

```yaml
review:
  defaults: { kind: codex, thinking: medium }
  members:
    - { name: alice, agent: reviewer }
  tasks:
    - { subject: Review the implementation, owner: alice }
```

A short form such as `review: [reviewer]` also works. Explicit spawn flags
override definitions, then team defaults, then lead defaults. Unknown
frontmatter keys are ignored. Seed-task owner `$lead` refers to the runtime
lead name.

```sh
herdr-teams team start review --name review-session
herdr-teams --team review-session team save saved-review --scope project
herdr-teams spawn alice --agent reviewer --model <model> --prompt "Review tests"
```

Saving exports role definitions and seed tasks, without pane IDs or task run
state. A failed start retains its team and launch records for inspection.

## Board and logs

```sh
herdr-teams --team demo board
herdr-teams --team demo board --once
herdr-teams --team demo status --json
herdr-teams --team demo log --follow
```

The board shows status columns, members, time in state, unread mail, dependencies,
branches and recent lead messages. Tab switches between tasks and members;
j/k selects. Enter peeks; m sends a message; u steers; i interrupts; r releases;
a assigns; o reopens; p approves a plan; n rejects with feedback; x kills; q exits.
Actions use the CLI's usual permission and blocked-agent checks.

Event hooks update member labels and workspace progress tokens. The board is
optional; delivery continues when it is closed.

## Installation details and support

The manifest runs `npm ci` and builds TypeScript during installation.
Development checkouts use `herdr plugin link .` after building.
`herdr plugin action invoke herdr-teams.install-shim` installs a `herdr-teams`
launcher in `~/.local/bin` for the lead and reports the result as a herdr
notification; `herdr-teams install-shim --directory <directory-on-PATH>` picks
another directory. The launcher asks herdr for the installed plugin on each
run, so it keeps working after `herdr plugin update`. It replaces only its own
earlier launcher or link, never another file.

Two agent skills teach the CLI:
[`skills/herdr-teams-lead`](../skills/herdr-teams-lead/SKILL.md) covers running a
team, agent definitions and team templates;
[`skills/herdr-teams-teammate`](../skills/herdr-teams-teammate/SKILL.md) covers a
member's commands and rules. Copy or link each directory into your agents'
skills directory, such as `.claude/skills/`.

Linux and macOS are the supported runtime platforms. Windows CI checks build
and CLI help only; Windows panes, signals and Unix sockets are not supported.
Codex launch flags and fake-herdr contracts are tested. Claude and pi mappings
remain untested here. OpenCode supports its documented model flag and exit
command; explicit thinking effort is refused because no TUI launch mapping is
verified. Live herdr latency and interactive board UX still need manual checks.
