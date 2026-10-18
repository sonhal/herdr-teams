# Core state

`Store` persists teams, tasks, dependencies, inboxes and events under
`$HERDR_TEAMS_HOME/teams/<team>` (falling back to `$HERDR_PLUGIN_STATE_DIR`
in the CLI). Task records and configuration use temporary-file-and-rename
writes. A team-wide mkdir lock serializes task and membership mutations,
including dependency cycle checks and claims. Locks older than a minute are
recovered only when their owner process is gone. Contenders time out after
10 seconds; retry an operation after an interrupted writer.

Inboxes and events use single append writes. Reading an inbox never marks it
delivered. Delivery cursors and urgent acknowledgements live separately.
Lifecycle, worktree, plan and hook services use the same store. Async operation
leases serialize long-running actions without holding the store lock over I/O.
Completion rechecks its task snapshot after gates and hooks finish.

Each JSON record is atomic, but a process crash between related dependency
writes or between a record and its event can leave partial bookkeeping.
The store assumes a local filesystem and trusted local configuration files.
