# Contributing to ZAPS

Thanks for your interest in improving ZAPS! This guide covers local setup and the
conventions we follow.

## Prerequisites

- [Node.js](https://nodejs.org) >= 22
- [pnpm](https://pnpm.io) (the repo pins a version via `packageManager`)
- [Bun](https://bun.sh) — used to build the native binary
- [tmux](https://github.com/tmux/tmux/wiki) >= 3.5a — ZAPS runs inside tmux

## Setup

```bash
git clone https://github.com/boshold/zaps.git
cd zaps
pnpm install
```

## Development

```bash
pnpm dev            # run the CLI from source (tsx)
pnpm test           # unit tests (vitest)
pnpm test -- path   # a single test file
pnpm test:integration   # integration tests (sequential, needs tmux)
pnpm typecheck      # tsc --noEmit
pnpm lint:fix       # oxfmt + oxlint (autofix)
pnpm build          # node bundle → dist/cli.mjs
pnpm build:native   # native binary → dist/zaps (Bun)
```

**Before opening a PR, run the full gate:**

```bash
pnpm check          # typecheck + lint:fix + build + build:native + test:coverage
```

Coverage has a global gate of 85% (lines/functions/statements/branches).

## Pull requests

- Branch off `main`; keep PRs focused.
- Use [Conventional Commits](https://www.conventionalcommits.org) for messages
  (e.g. `feat(tui): …`, `fix(config): …`, `docs: …`).
- Update user-facing docs when behavior changes: `README.md`, the
  `.claude/skills/zaps-config` and `.claude/skills/zaps-usage` skills.
- Make sure `pnpm check` passes and CI is green.

## Architecture

See [`CLAUDE.md`](./CLAUDE.md) for an overview of the core layers (CLI, daemon,
service manager, TUI, config, MCP) and key patterns.

## Reporting issues

Use the [issue tracker](https://github.com/boshold/zaps/issues). For security
reports, follow [`SECURITY.md`](./SECURITY.md) instead of opening a public issue.
