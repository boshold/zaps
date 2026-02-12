<div align='center'>
   <p>
     
![ZAPS](https://github.com/user-attachments/assets/a20356a5-8dd4-4ab8-a6ba-ef5daaa98108)

   <p>
      <a href="https://github.com/kboshold/zaps/blob/master/LICENSE">
         <picture>
            <source media="(prefers-color-scheme: dark)" type="image/svg+xml" srcset="https://img.shields.io/github/license/kpalatzky/nvim.dotfiles.svg?color=cba6f7&labelColor=b4befe">
            <img src="https://img.shields.io/github/license/kpalatzky/nvim.dotfiles.svg?color=8839ef" alt="MIT License"/>
         </picture>
      </a>
      <a href="https://github.com/tmux/tmux/wiki#-is-awesome">
         <picture>
            <source media="(prefers-color-scheme: dark)" type="image/svg+xml" srcset="https://img.shields.io/badge/%3E%3D3.5a-a6e3a1?logo=tmux&label=tmux&labelColor=313244&logoColor=a6e3a1">
            <img alt="Tmux >= 3.5a" src="https://img.shields.io/badge/%3E%3D3.5a-40a02b?logo=tmux&label=tmux&labelColor=ccd0da&logoColor=40a02b">
         </picture>
       </a>
   </p>
   <hr>
   <p>
      <h3>⚡ Make your project setup painless ⚡</h3>
      <div>Zero Ass Pain Setup — a terminal session manager that orchestrates dev services inside tmux with an interactive TUI.</div>
      <div>Define services, dependencies, tasks, and layout in a single config file. ZAPS handles tmux pane layout, service lifecycle, crash recovery, and a keyboard-driven dashboard.</div>
   </p>
</div>

## Prerequisites

- [tmux](https://github.com/tmux/tmux/wiki#-is-awesome)

## Quick Start

```bash
# Inside a tmux session:
zaps init          # Scaffold .zaps.mts config
# Edit .zaps.mts to define your services
zaps               # Launch
```

> ZAPS must be run from inside a tmux session.

## Commands

### `zaps` / `zaps dev`

Launch the dev session. Builds the pane layout from the current tmux pane, starts services, and renders the TUI dashboard.

### `zaps init`

Scaffold a starter `.zaps.mts` in the current directory.

### `zaps sessions`

List active tmux sessions.

### `zaps down`

Stop all services and kill spawned panes in the current tmux session.

## Configuration

### Config Discovery

ZAPS walks up from the current directory looking for these filenames (first match wins):

1. `.local.zaps.mts` — local override (gitignore this)
2. `local.zaps.mts`
3. `.local.zaps.ts`
4. `local.zaps.ts`
5. `.zaps.mts` — primary config
6. `.zaps.ts`

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
        docker: {
          service: "postgres",
          file: "./docker-compose.yml",
          build: true,
          forceRecreate: false,
          renewVolumes: false,
          removeOrphans: true,
          pull: "missing",
          noDeps: false,
        },
        restart: { maxRetries: 5, backoff: 2000 },
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
        ready: { port: true },
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
        description: "Apply pending database migrations",
        commands: "npx prisma migrate deploy",
        cwd: "./packages/api",
        shortcut: "m",
      },
      seed: {
        name: "Seed database",
        commands: ["npx prisma db seed", "npx prisma db fixtures"],
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
| `stop`      | `string \| () => string`                    | —       | Custom stop command (default: Ctrl-C) |
| `docker`    | `DockerConfig`                              | —       | Docker Compose service config         |
| `ready`     | `ReadyConfig`                               | —       | How to detect the service is ready    |
| `dependsOn` | `string[]`                                  | `[]`    | Services that must be ready first     |
| `env`       | `Record<string, string> \| (ctx) => Record` | —       | Environment variables                 |
| `cwd`       | `string`                                    | —       | Working directory                     |
| `url`       | `string \| (ctx) => string`                 | —       | URL for browser open (`o` key)        |
| `autostart` | `boolean`                                   | `true`  | Start automatically on launch         |
| `detached`  | `boolean`                                   | `false` | Run outside tmux (no pane)            |
| `restart`   | `{ maxRetries?, backoff? }`                 | —       | Auto-restart on crash                 |

### Ready Detection

Four strategies for detecting when a service is ready:

**Port** — wait for a TCP port:

```typescript
ready: {
  port: 3000;
} // specific port
ready: {
  port: true;
} // any port
ready: {
  port: () => getPort();
} // dynamic port
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

**Docker** — wait for container running + healthy:

```typescript
ready: { docker: "postgres" }
ready: { docker: "postgres", file: "./docker-compose.yml" }
```

**Function** — custom async check:

```typescript
ready: async () => {
  const res = await fetch("http://localhost:3000/health");
  return res.ok;
};
```

Ready checks poll every 500ms with a 60s timeout.

### Docker Integration

When a service has `docker` config and no `start`/`run`, ZAPS auto-generates a `docker compose up` command.

If no `ready` config is provided, ZAPS defaults to checking the docker container state (running + healthy).

| Option          | Type                               | Default | Description                            |
| --------------- | ---------------------------------- | ------- | -------------------------------------- |
| `service`       | `string`                           | —       | Docker Compose service name (required) |
| `file`          | `string`                           | —       | Path to compose file                   |
| `build`         | `boolean`                          | —       | `--build` flag                         |
| `forceRecreate` | `boolean`                          | —       | `--force-recreate` flag                |
| `renewVolumes`  | `boolean`                          | —       | `-V` flag (recreate volumes)           |
| `removeOrphans` | `boolean`                          | —       | `--remove-orphans` flag                |
| `pull`          | `"always" \| "missing" \| "never"` | —       | `--pull` strategy                      |
| `noDeps`        | `boolean`                          | —       | `--no-deps` flag                       |

### Dependencies

Services start in topological order. Services at the same level start in parallel:

```typescript
services: {
  db: { start: "..." },           // Level 0 — starts first
  cache: { start: "..." },        // Level 0 — parallel with db
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

Backoff doubles per retry: 2s → 4s → 8s → 16s → 32s. Crash monitoring polls every 2s.

### Dynamic Environment

Access other services' runtime info via `ServiceContext`:

```typescript
env: (ctx) => ({
  DATABASE_URL: `postgres://localhost:${ctx.services.db.port}/mydb`,
  API_PORTS: ctx.services.api.ports.join(","),
  PROJECT_DIR: ctx.projectDir,
});
```

`ServiceContext` shape:

```typescript
{
  services: Record<
    string,
    {
      port: number | undefined; // first detected port
      ports: number[]; // all detected ports
      cwd: string | undefined;
    }
  >;
  projectDir: string;
}
```

## Tasks

One-off commands runnable from the TUI:

```typescript
tasks: {
  migrate: {
    name: "Run migrations",
    description: "Apply pending database migrations",
    commands: "npx prisma migrate deploy",
    cwd: "./packages/api",
    dependsOn: ["seed"],
    env: { NODE_ENV: "production" },
    shortcut: "m",
  },
  "reset-db": {
    name: "Reset database",
    commands: [
      "npx prisma migrate reset --force",
      "npx prisma db seed",
    ],
  },
}
```

Task dependencies are resolved and executed before the task itself.

### Shortcuts

Tasks can define a `shortcut` key for quick execution via chord mode. If no shortcut is specified, ZAPS auto-assigns the first unique character from the task key.

Press `t` on the dashboard to enter chord mode. Then press a shortcut key to immediately run that task. Any unmatched key or `Enter` opens the full tasks list instead.

## Layout

Define a custom tmux pane layout. The `@tui` pane is **required** — it hosts the ZAPS dashboard.

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
- Services not in the layout get their own background tmux window
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
| `t`       | Tasks (chord mode or list)     |
| `a`       | Restart all services           |
| `q`       | Stop all and quit              |

### Chord Mode

Shown when any task has a shortcut. Press a shortcut key to run it, `Esc` to cancel, `Enter` or any unmatched key to open the tasks list.

### Tasks View

| Key       | Action            |
| --------- | ----------------- |
| `Up/Down` | Navigate tasks    |
| `Enter`   | Run selected task |
| `Esc`     | Back to dashboard |

### Log View

| Key       | Action            |
| --------- | ----------------- |
| `Up/Down` | Scroll logs       |
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

## License

MIT
