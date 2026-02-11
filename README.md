# ZAPS

**Zero Ass Pain Setup** — a terminal session manager that orchestrates your dev services inside tmux with an interactive TUI.

Define your services, dependencies, tasks, and layout in a single `.zaps.mts` config file. ZAPS handles the rest: tmux session creation, pane layout, service lifecycle management, crash detection with auto-restart, and a keyboard-driven dashboard.

## Prerequisites

- [tmux](https://github.com/tmux/tmux)
- [Node.js](https://nodejs.org/) >= 18
- Linux or macOS

## Installation

```bash
npm install -g zaps
```

## Quick Start

```bash
# Initialize a config file in your project
zaps init

# Edit .zaps.mts to define your services

# Launch
zaps
```

## Commands

### `zaps` / `zaps ui`

Launch the TUI dashboard. Creates a tmux session, builds the pane layout, starts services, and attaches.

### `zaps init`

Scaffold a starter `.zaps.mts` in the current directory.

### `zaps sessions`

List active tmux sessions.

### `zaps down`

Stop all services and kill the tmux session.

```bash
zaps down              # Auto-detect from config
zaps down -n myproject # Specify project name
```

## Configuration

ZAPS looks for config files walking up from the current directory. Filenames checked (in order):

1. `.local.zaps.mts` — local overrides (gitignored)
2. `.local.zaps.ts`
3. `.zaps.mts` — primary config
4. `.zaps.ts`

### Minimal Config

```typescript
import type { Library } from "zaps";

export function config({ defineProject }: Library) {
  return defineProject({
    services: {
      api: {
        start: "npm run dev",
        ready: { port: 3000 },
      },
    },
  });
}
```

### Full Config Reference

```typescript
import type { Library } from "zaps";

export function config({ defineProject }: Library) {
  return defineProject({
    name: "my-app",

    services: {
      db: {
        start: "docker compose up postgres",
        ready: { port: 5432 },
        restart: { maxRetries: 3, backoff: 1000 },
      },

      api: {
        start: "npm run dev:api",
        ready: { output: /listening on port/ },
        dependsOn: ["db"],
        cwd: "./packages/api",
        env: { NODE_ENV: "development" },
        url: "http://localhost:4000",
      },

      web: {
        start: "npm run dev:web",
        ready: { port: 3000 },
        dependsOn: ["api"],
        url: (ctx) => `http://localhost:${ctx.services.web.port}`,
      },

      worker: {
        run: "npm run worker",
        detached: true,
        autostart: false,
      },
    },

    tasks: {
      migrate: {
        name: "Run migrations",
        commands: "npm run db:migrate",
        cwd: "./packages/api",
      },
      seed: {
        name: "Seed database",
        commands: ["npm run db:seed", "npm run db:fixtures"],
        dependsOn: ["migrate"],
      },
    },

    layout: {
      direction: "columns",
      children: [
        { pane: "@tui", size: "30" },
        {
          direction: "rows",
          children: [
            { pane: "api", size: "50" },
            { pane: "web", size: "50" },
          ],
        },
      ],
    },

    hooks: {
      onStart: () => console.log("All services started"),
      onStop: () => console.log("Shutting down"),
      onServiceStart: (name) => console.log(`${name} is ready`),
      onServiceStop: (name) => console.log(`${name} stopped`),
    },
  });
}
```

## Services

### Options

| Option      | Type                                        | Default | Description                           |
| ----------- | ------------------------------------------- | ------- | ------------------------------------- |
| `start`     | `string \| () => string`                    | —       | Command to start the service          |
| `run`       | `string \| () => string`                    | —       | Alias for `start`                     |
| `stop`      | `string`                                    | —       | Custom stop command (default: Ctrl-C) |
| `ready`     | `ReadyConfig`                               | —       | How to detect the service is ready    |
| `dependsOn` | `string[]`                                  | `[]`    | Services that must be ready first     |
| `env`       | `Record<string, string> \| (ctx) => Record` | —       | Environment variables                 |
| `cwd`       | `string`                                    | —       | Working directory                     |
| `url`       | `string \| (ctx) => string`                 | —       | URL for browser open (`o` key)        |
| `autostart` | `boolean`                                   | `true`  | Start automatically on launch         |
| `detached`  | `boolean`                                   | `false` | Run outside tmux (no pane)            |
| `restart`   | `{ maxRetries?, backoff? }`                 | —       | Auto-restart on crash                 |

### Ready Detection

Three strategies for detecting when a service is ready:

**Port** — wait for a TCP port to start listening:

```typescript
ready: {
  port: 3000;
}
ready: {
  port: () => parseInt(process.env.PORT);
}
```

**Output** — match against pane output:

```typescript
ready: {
  output: /listening on port \d+/;
}
ready: {
  output: (line) => line.includes("ready");
}
```

**Function** — custom async check:

```typescript
ready: async () => {
  const res = await fetch("http://localhost:3000/health");
  return res.ok;
};
```

Ready checks poll every 500ms with a 60s timeout.

### Dependencies

Services start in topological order. Dependencies within the same level start in parallel:

```typescript
services: {
  db: { start: "..." },           // Level 0 — starts first
  cache: { start: "..." },        // Level 0 — starts in parallel with db
  api: {
    start: "...",
    dependsOn: ["db", "cache"],   // Level 1 — waits for both
  },
  web: {
    start: "...",
    dependsOn: ["api"],           // Level 2 — waits for api
  },
}
```

Shutdown runs in reverse topological order.

### Crash Recovery

Enable auto-restart with exponential backoff:

```typescript
restart: {
  maxRetries: 5,    // default: 3
  backoff: 2000,    // base delay in ms, default: 1000
}
```

Backoff doubles per retry: 2s, 4s, 8s, 16s, 32s.

### Dynamic Environment

Access other services' ports and project directory at runtime:

```typescript
env: (ctx) => ({
  DATABASE_URL: `postgres://localhost:${ctx.services.db.port}/mydb`,
  PROJECT_DIR: ctx.projectDir,
});
```

## Tasks

One-off commands that can be run from the TUI:

```typescript
tasks: {
  migrate: {
    name: "Run migrations",
    description: "Apply pending database migrations",
    commands: "npx prisma migrate deploy",
    cwd: "./packages/api",
  },
  "reset-db": {
    name: "Reset database",
    commands: [
      "npx prisma migrate reset --force",
      "npx prisma db seed",
    ],
    dependsOn: ["migrate"],
  },
}
```

Task dependencies are resolved and executed before the task itself.

## Layout

Define a custom tmux pane layout. The `@tui` pane is required — it hosts the ZAPS dashboard.

```typescript
layout: {
  direction: "columns",
  children: [
    { pane: "@tui", size: "25" },
    {
      direction: "rows",
      children: [
        { pane: "api", size: "60" },
        { pane: "web", size: "40" },
      ],
    },
  ],
}
```

- `direction`: `"rows"` (vertical split) or `"columns"` (horizontal split)
- `size`: percentage of parent (defaults to equal split)
- Services not included in the layout get their own background tmux window
- Detached services must **not** appear in the layout

If no layout is specified, `@tui` gets the main pane and each service gets a background window.

## TUI Keyboard Shortcuts

### Dashboard

| Key       | Action                         |
| --------- | ------------------------------ |
| `Up/Down` | Navigate services              |
| `r`       | Restart selected service       |
| `s`       | Start/stop selected service    |
| `l`       | View logs for selected service |
| `o`       | Open service URL in browser    |
| `t`       | Switch to tasks view           |
| `a`       | Restart all services           |
| `q`       | Stop all and quit              |

### Log View

| Key       | Action            |
| --------- | ----------------- |
| `Up/Down` | Scroll logs       |
| `Esc`     | Back to dashboard |

### Tasks View

| Key       | Action            |
| --------- | ----------------- |
| `Up/Down` | Navigate tasks    |
| `Enter`   | Run selected task |
| `Esc`     | Back to dashboard |

## Service States

```
stopped ──> starting ──> ready ──> stopping ──> stopped
               │            │
               v            v
             error      restarting ──> starting
               │
               v
            starting (retry)
```

| State                                  | Indicator      |
| -------------------------------------- | -------------- |
| `ready`                                | Green `●`      |
| `starting` / `stopping` / `restarting` | Yellow spinner |
| `error`                                | Red `✖`        |
| `stopped`                              | Gray `○`       |

## Hooks

Lifecycle hooks for custom logic:

```typescript
hooks: {
  onStart: async () => { /* all services started */ },
  onStop: async () => { /* cleanup before exit */ },
  onServiceStart: async (name) => { /* individual service ready */ },
  onServiceStop: async (name) => { /* individual service stopped */ },
}
```

## How It Works

ZAPS uses a two-process architecture:

1. **Outer process** — creates the tmux session, builds the pane layout, launches the inner process in the `@tui` pane, then attaches to the session
2. **Inner process** — runs inside tmux, manages service lifecycle, renders the TUI dashboard

Services are started by sending commands to their tmux panes via `send-keys`. Port detection uses `ss` (Linux) or `lsof` (macOS) against the process tree. Crash monitoring polls every 2s checking if child processes are still alive.

## License

MIT
