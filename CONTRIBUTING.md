# Contributing to ZAPS

Thanks for your interest in improving ZAPS! This guide covers local setup and the
conventions we follow.

## Prerequisites

- [Node.js](https://nodejs.org) >= 22.22 for development
- [pnpm](https://pnpm.io) (the repo pins a version via `packageManager`)
- [Bun](https://bun.sh), pinned in `.bun-version`, for native builds
- [tmux](https://github.com/tmux/tmux/wiki) >= 3.5 for service orchestration and integration tests
- [Docker](https://www.docker.com/) with Compose >= 2.21 for Docker integration tests

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
Run `pnpm test:integration` separately after building the native binary.
Each integration run uses a private tmux socket directory.
CI builds and releases on Node 26, tests Node 22 and 26, and runs integration tests
on tmux 3.5a and 3.8.

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

## Releasing

Maintainers release from the Actions tab: **Release > Run workflow** on `main`, pick
`patch`, `minor` or `major`. The run tests everything, writes the next version
into `package.json`, pushes a `chore(release): vX.Y.Z` commit with its tag,
publishes `@bosdev/zaps` and the platform packages to npm and attaches the
binaries and `SHA256SUMS` before making the GitHub release public.
`dry-run` builds and packs
without pushing or publishing. Don't push version tags or edit the version by hand.

## Reporting issues

Use the [issue tracker](https://github.com/boshold/zaps/issues). For security
reports, follow [`SECURITY.md`](./SECURITY.md) instead of opening a public issue.
