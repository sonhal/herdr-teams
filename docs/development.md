# Development

[Back to the README](../README.md)

## Build and check

Requires Node.js ≥ 20 and npm.

```sh
npm ci
npm run build
npm test
npm run lint
npm run typecheck
./bin/herdr-teams --help
```

The shim at `bin/herdr-teams` loads `dist/bin/herdr-teams.js`. Build before
linking the checkout; `herdr plugin link` does not run a build.

```sh
herdr plugin link .
herdr plugin action invoke herdr-teams.start-team
```

Invoking an action requires a running herdr ≥ 0.9.5 session. Rebuild after
changing TypeScript.

## Tests

Unit and contract tests use a scripted fake herdr executable, so no coding
agents or API keys are needed. They check our logic, not herdr's behaviour.
Run integration tests against the pinned herdr release with the stand-in
Codex agent:

```sh
HERDR_BIN_PATH=$(sh scripts/fetch-herdr.sh) npm run test:live
```

CI runs lint, type checks, tests and builds on Node.js 20, 22 and 24, plus
live herdr tests on Linux. Windows CI checks builds and CLI help only.
See [support limitations](usage.md#installation-details-and-support) for
the remaining manual checks and agent adapter coverage.

## Code map and technologies

| Area | Technology and entry point |
| --- | --- |
| CLI | TypeScript on Node.js; Commander parses commands in `src/cli/`. |
| Templates and roles | YAML templates and Markdown role files with YAML frontmatter; parsed with the `yaml` package. |
| Persistent state | Local JSON records and append-only inbox/event files; [core state](../src/core/README.md). |
| Terminal integration | herdr plugin manifest, CLI and Unix socket API; `src/herdr/` and [runtime hooks](../src/runtime/README.md). |
| Coding agents | External Claude Code, Codex, pi and OpenCode CLIs; [adapters](../src/adapters/README.md). |
| Board | Terminal interface; [board implementation](../src/board/README.md). |
| Checks | Vitest, ESLint, Prettier and the TypeScript compiler. |

Read [AGENTS.md](../AGENTS.md) for contribution rules. The
[design plan](PLAN.md) records the architecture and original scope; use the
CLI and [usage reference](usage.md) for current behaviour.
