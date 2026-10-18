# Terminal board

The board reads team files and never queries herdr or advances inbox cursors.
Rendering is separate from interaction. Keyboard actions call the same CLI
handlers as shell users, preserving identity, authorization and blocked-agent
checks. Terminal control sequences are stripped from stored text before display.

Non-terminal output and `--once` render a snapshot. `--json` uses the same data
model as `status`. Event hooks and successful commands update sidebar metadata only when its
content changes. Delivery continues independently of the board.
