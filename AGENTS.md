# Project instructions

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
- Creating a pull request does not authorize merging it. Merge only when the
  user explicitly asks.
- This repository uses squash merges. After a prerequisite PR lands, rebase
  dependent branches onto the updated `origin/main`, omitting the original
  prerequisite commits, and push with explicit `--force-with-lease` guards.
- Push and get CI green. Don't merge unless the owner asks.

Writing style

Applies to code comments, docs, README, plans, commit messages and PR bodies.

    Be short. Say each thing once, in the place a reader will look for it.
    Comments explain why or a non-obvious constraint. Don't restate the code or narrate what you changed.
    No session narrative: no dates, incident stories, "learned the hard way", or notes about what an agent tried.
    Never write details of your environment: home directories, usernames, hostnames, IP addresses, sandbox or scratchpad paths, tokens, e-mail addresses. Use placeholders (<scratchpad>, example.com, RFC 5737 IPs).
    README is for people who run and use nyttig: install, config, CLI, deploy. Internals belong in code comments and tests, not the README.
    Update this file only when a rule or a cross-cutting invariant changes, and then edit the existing entry instead of appending a new paragraph.
