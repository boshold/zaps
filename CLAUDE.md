# CLAUDE.md

## Commands

```bash
pnpm check                    # full CI: typecheck + lint:fix + build + build:native + test:coverage
pnpm test                     # unit tests (vitest)
pnpm test -- path/to/file     # single test file
pnpm test:integration         # integration tests (sequential, 60s timeout, needs tmux)
pnpm test:coverage            # unit tests with coverage (85% lines/functions/statements, 89% branches)
pnpm typecheck                # tsc --noEmit
pnpm lint                     # oxfmt --check + oxlint (type-aware, deny-warnings)
pnpm lint:fix                 # oxfmt --write + oxlint --fix
pnpm build                    # esbuild bundle → dist/cli.mjs + tsc declarations
pnpm build:native             # bun native binary → dist/zaps
```

**Always run `pnpm check` before finishing your task.**

## Architecture

**ZAPS** (Zero Ass Pain Setup) — tmux session manager that orchestrates dev services with a React/Ink TUI.

### Core layers

- **CLI** (`src/cli.tsx`) — Commander.js commands, entry point
- **Daemon** (`src/daemon/`) — background Unix socket IPC server managing sessions
- **Service Manager** (`src/lib/service/manager.ts`) — lifecycle, dependency graph, ready detection, crash recovery
- **TUI** (`src/components/`) — React/Ink terminal UI with Dashboard, LogView, TasksView
- **Config** (`src/config/`) — discovery, Zod validation, builder API for `.zaps.mts` files
- **MCP** (`src/mcp/server.ts`) — Model Context Protocol server for AI agents
- **Client** (`src/client/daemon-client.ts`) — TUI↔daemon EventEmitter bridge

### Key patterns

- Path alias: `#src/*` → `./src/*`
- IPC: JSON over Unix sockets (ndjson for log streaming)
- JSX runtime: `react-jsx` (React 19 + Ink 6)
- Config discovery walks up from CWD for `.zaps.mts`/`.zaps.ts`/`local.zaps.ts` variants

## Skills & README

**Always update these when changing user-facing behavior:**

- `README.md` — CLI commands, config options, usage docs
- `.claude/skills/zaps-config/` — config authoring skill + reference docs
- `.claude/skills/zaps-usage/` — CLI usage skill

## Tech

- TypeScript (ES2023, strict, ESM)
- React 19 + Ink 6 (TUI)
- Zod 4 (config validation)
- Commander 14 (CLI)
- Vitest 4 (testing), oxlint/oxfmt (lint/format)
- esbuild (bundle), bun (native binary)
