# Agent adapters

Codex model and thinking flags are checked against `codex --help`. Claude and
pi mappings follow PLAN §13 and remain untested here. Tests launch only Codex
fixtures; no Claude runtime is required. Interrupt and exit operations preserve
the user's sandbox and approval defaults.

OpenCode model and exit mappings follow its CLI/TUI documentation at upstream
commit `802f2d8e75098ae0b45ad839ce98a31589ea8102`. Its TUI has no documented
launch effort flag, so explicit effort is rejected. Urgent delivery uses the
conservative interrupt-then-idle path. No OpenCode runtime is launched in tests.
