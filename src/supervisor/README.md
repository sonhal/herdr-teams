# Delivery

`_hook event` and `_hook startup` reconcile registered members with herdr's
live agent list. The CLI also reconciles after successful commands. Hooks use
live state rather than trusting event payloads, so repeated or stale events are
harmless. The supervisor's future tick and reconnect paths can call `reconcile`.

Waiting messages arrive as one prompt when the recipient is idle or done.
Working, blocked, missing and unknown agents keep their mail. Blocked recipients
produce one lead notice per observed blocked episode. Urgent mail remains queued;
working-agent steering belongs to M4.

Completed turns produce a coalesced lead report keyed by herdr's completion
sequence. Reports include owned tasks and the last direct message, or recent
pane output. Idle teammates with no waiting mail or active task claim the first
unassigned, unblocked task, unless `auto_claim` is false in team config.

M2 lifecycle support is not yet on main. Members must already be registered and
running under their team member names in herdr. No real-agent integration test
has been run; contract tests use Codex fixtures and a fake herdr subprocess.

Delivery is at least once: a crash after herdr accepts a prompt but before the
cursor is saved can repeat it. Individual records are replaced atomically;
related task, message, report and cursor writes are not one crash-safe
transaction. A delivery lease serializes hooks; a later invocation clears a
lease older than a minute only when its owner process has exited. Reconciliation
on the following invocation resumes delivery.
