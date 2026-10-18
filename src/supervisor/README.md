# Delivery

`_hook event` and `_hook startup` reconcile registered members with herdr's
live agent list. The CLI also reconciles after successful commands. Hooks use
live state rather than trusting event payloads, so repeated or stale events are
harmless. The supervisor tick and reconnect paths also call `reconcile`.

Waiting messages arrive as one prompt when the recipient is idle or done.
Blocked, missing and unknown agents keep their mail. Working Codex agents receive
urgent mail; other kinds use interrupt-then-idle delivery. Blocked recipients
produce one lead notice per observed blocked episode. Acknowledged urgent messages do not skip older ordinary mail.

Completed turns produce a coalesced lead report keyed by member incarnation and
herdr's completion sequence. Reports include owned tasks and a new direct message,
or recent pane output. Idle teammates without an active task claim assigned work
first, then unassigned work when no mail is waiting, unless `auto_claim` is false.

Lifecycle reconciliation confirms exits and releases active tasks. Registered
pane IDs guard against unrelated agents with the same name. No real-agent
integration test has been run; contract tests use Codex fixtures and a fake
herdr subprocess.

Delivery is at least once: a crash after herdr accepts a prompt but before the
cursor is saved can repeat it. Individual records are replaced atomically;
related task, message, report and cursor writes are not one crash-safe
transaction. A delivery lease serializes hooks; a later invocation clears a
lease older than a minute only when its owner process has exited. Reconciliation
on the following invocation resumes delivery.

`supervise` opens a plugin pane. Inside that pane it subscribes to herdr's Unix
socket, serializes event handling, samples progress on a configurable clock,
and reconnects with a fresh session snapshot after disconnect or event loss.
The startup hook reopens missing supervisor panes. `supervisor.mode: off`
retains hook delivery without time-based advisories.
Roster changes reconnect the event stream to subscribe to new pane IDs.
Event hooks check for a connected supervisor before starting Node and skip teams
already served by one. Disconnected or exited supervisors restore fallback delivery.

Advisories use state changes, member CLI activity and normalized output hashes.
Each episode has one notice and one recovery. Recent human focus or an
`interactive` member suppresses lead notices. Needs-input also notifies the
human. Optional status-check nudges never close or restart agents.

`peek` reads output. `interrupt` and task release send Esc and optionally queue
context-preserving instructions; blocked agents refuse these actions. Urgent
Codex delivery uses herdr prompt input; other adapters save one interrupt attempt
while urgent mail waits, then wait for idle before delivering it.
