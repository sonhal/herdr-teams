# Delivery

`_hook event` and `_hook startup` reconcile registered members with herdr's
live agent list. The CLI also reconciles after successful commands. Hooks use
live state rather than trusting event payloads, so repeated or stale events are
harmless. Hooks are the normal delivery path; no pane or persistent process is
required.

Waiting messages arrive as one prompt when the recipient is idle or done.
Blocked, missing and unknown agents keep their mail. Working Codex agents receive
urgent mail; other kinds use interrupt-then-idle delivery. Blocked recipients
produce one lead notice per observed blocked episode. Acknowledged urgent messages do not skip older ordinary mail.

A completed turn in which the teammate sent the lead nothing produces a report
with recent pane output, keyed by member incarnation and herdr's completion
sequence, but only when the teammate holds an active task or the turn was its
first. Task completions reach the lead from `task complete` instead. Idle
teammates without an active task claim assigned work first, then unassigned
work when no mail is waiting, unless `auto_claim` is false.

Lifecycle reconciliation confirms exits and releases active tasks. Registered
pane IDs guard against unrelated agents with the same name. Contract tests use Codex fixtures and a fake herdr subprocess. A live herdr
0.9.5 check with stand-in agent executables verifies hook dispatch, lead delivery,
completion reports and exit classification; real coding-agent UX remains unverified.

Delivery is at least once: a crash after herdr accepts a prompt but before the
cursor is saved can repeat it. Individual records are replaced atomically;
related task, message, report and cursor writes are not one crash-safe
transaction. A delivery lease serializes hooks. Concurrent invocations wait up to ten seconds
for a fresh pass rather than discarding events; contention beyond that fails
explicitly. A lease older than a minute is recovered only when its owner process
has exited. Startup and subsequent commands retry pending delivery.

`peek` reads output. `interrupt` and task release send Esc and optionally queue
context-preserving instructions; blocked agents refuse these actions. Urgent
Codex delivery uses herdr prompt input; other adapters save one interrupt attempt
while urgent mail waits, then wait for idle before delivering it.
