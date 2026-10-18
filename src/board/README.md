# Terminal board

The board reads team files and never queries herdr or advances inbox cursors.
Rendering is separate from interaction. Keyboard actions call the same CLI
handlers as shell users, preserving identity, authorization and blocked-agent
checks. Terminal control sequences are stripped from stored text before display.

Non-terminal output and `--once` render a snapshot. `--json` uses the same data
model as `status`. The supervisor updates sidebar metadata only when its content
changes. The board reports supervisor availability from its local process lease.
