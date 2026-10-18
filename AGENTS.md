# Project instructions

## Ethos

- herdr-teams allows team members to communicate with each other so make sure
  that features are very careful about bloating the context unnecessary much.
  The agents should get the information they need from each other but always
  think about if the feature can be implemented exposing the agents to less
  noise.

## Git workflow

- Before implementing a new feature, create and switch to a dedicated feature
  branch based on `main`.
- If already working on the feature's branch, continue there.
- Keep feature implementation commits off `main`; do not commit or push new
  features directly to `main`.
- Agents may open a pull request from their feature branch when they judge it
  ready for review, without asking for additional permission.
- A request to work on a feature or issue authorizes the full workflow:
  implement the change, run the appropriate checks, commit the completed work,
  push the feature branch, and open a pull request targeting `main`.
- Do not stop at local changes or wait for a separate request to commit, push,
  or create the pull request. Follow any explicit user instruction that limits
  this workflow.
- If the branch already has an open pull request, push follow-up commits to
  that branch and update the existing pull request instead of creating another.
- Write the pull request title and description around the final change,
  including validation results and any material limitations.
- Finish by sharing the pull request link and a brief summary of the change
  and checks. If a step is blocked, explain the blocker and what remains.
- Push and get CI green. Creating a pull request does not authorize merging
  it; merge only when the owner explicitly asks.
- This repository uses squash merges. After a prerequisite PR lands, rebase
  dependent branches onto the updated `origin/main`, omitting the original
  prerequisite commits, and push with explicit `--force-with-lease` guards.

## Engineering rules

- herdr is the external contract. Check each CLI command, flag, event and
  environment variable against herdr's source or `--help` at the version
  named in `tests/helpers/fixtures.ts`, and name that version beside new
  fixtures. A test against the scripted fake herdr proves our logic, not
  herdr's behaviour.
- Team isolation: a command, hook or supervisor tick reads and writes only
  the team it was invoked for. The state home is shared by every team and
  every herdr session; pane IDs and agent names are not unique across them.
  Match a teammate on agent name and pane, never pane alone. The lead is
  whatever agent runs in the lead pane of the team's own herdr session.
- Authority is per effect, not per command. A command that leads to an
  interrupt, a key press, a pane close or a task release requires the same
  authority as the direct command, even when the effect happens later.
- Loops over members or teams handle errors per item: one failure must not
  block delivery, shutdown or advisories for the others. Save state before
  calling herdr in any step that can be retried, so a retry doesn't send a
  duplicate message. Bound anything passed as a command argument; Linux
  limits one argument to 128 KiB.
- A bug fix starts with a test that fails without it. Cover failure paths
  (herdr errors, missing panes, restarts, respawns), not only success.
- Unimplemented features fail loudly: placeholder commands exit non-zero and
  options for unbuilt features are rejected, not ignored. Prompts sent to
  agents name only working commands.

## Testing

- Features needs to be tested against an actually running herdr instance
  before it can be trusted to work.

## Writing style

Applies to code comments, docs, README, plans, commit messages and PR bodies.

- Be short. Say each thing once, in the place a reader will look for it.
  Docs and comments describe what the code does now; when behaviour changes,
  fix the sentence that describes it in the same commit.
- Comments explain why or a non-obvious constraint. Don't restate the code or
  narrate what you changed.
- No session narrative: no dates, incident stories, "learned the hard way", or
  notes about what an agent tried.
- Never write details of your environment: home directories, usernames,
  hostnames, IP addresses, sandbox or scratchpad paths, tokens, e-mail
  addresses. Use placeholders (<scratchpad>, example.com, RFC 5737 IPs).
- README is for people who run and use herdr-teams: install, config, CLI,
  deploy. Internals belong in code comments and tests, not the README.
- Update this file only when a rule or a cross-cutting invariant changes, and
  then edit the existing entry instead of appending a new paragraph.
