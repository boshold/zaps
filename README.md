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
      <h3>⚡ Painless project setup ⚡</h3>
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

### Lifecycle

| Command            | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| `zaps` / `zaps up` | Smart default: attach if session running, else create + start + attach TUI |
| `zaps up -d`       | Create session and start services without attaching TUI (detached)         |
| `zaps down`        | Stop all services and destroy session                                      |

### Service Operations

| Command                     | Description                        |
| --------------------------- | ---------------------------------- |
| `zaps start [service...]`   | Start service(s). All if omitted   |
| `zaps stop [service...]`    | Stop service(s). All if omitted    |
| `zaps restart [service...]` | Restart service(s). All if omitted |

### Query

| Command                  | Description                                    |
| ------------------------ | ---------------------------------------------- |
| `zaps ps`                | List services with state, ports, URL. `--json` |
| `zaps ls`                | List active sessions. `--json`                 |
| `zaps inspect <service>` | Show service details. `--json`                 |

### Tasks & Logs

| Command                  | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| `zaps run <task>`        | Run a task. Streams output. `--json`                             |
| `zaps tasks`             | List configured tasks. `--json`                                  |
| `zaps logs [service...]` | Dump log buffer. `-f` to stream live. `--tail <n>` (default 100) |
| `zaps events`            | Stream daemon events as ndjson. `--filter <type>`                |

### Config & Setup

| Command                           | Description                                            |
| --------------------------------- | ------------------------------------------------------ |
| `zaps config`                     | Validate and print resolved config. `--json`, `--path` |
| `zaps init`                       | Scaffold a starter `.zaps.mts` config                  |
| `zaps attach [session]`           | Attach TUI to a running session                        |
| `zaps daemon start\|stop\|status` | Daemon management                                      |

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
    cwd: "./packages/app",

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
        onOutput: (line) => {
          if (/error/i.test(line)) notifySlack(line);
        },
      },

      worker: {
        run: "npm run worker",
        detached: true,
        flags: { start: false },
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
        popup: true,
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
      onBeforeStart: () => console.log("Running setup"),
      onStart: () => console.log("All services started"),
      onStop: () => console.log("Shutting down"),
    },

    ui: {
      icons: "nerd",
      notifications: "osc9",
      failOutput: "overlay",
      wideThreshold: 100,
      task: { defaultMode: "background", popupPicker: false },
    },
  });
}
```

See [UI Config](#ui-config) for the full `ui` block reference.

## Project Options

| Option | Type                                    | Default    | Description               |
| ------ | --------------------------------------- | ---------- | ------------------------- |
| `name` | `string`                                | dir name   | Project name shown in TUI |
| `cwd`  | `string \| (ctx: CwdContext) => string` | invoke dir | Project working directory |

### `cwd`

By default, `projectDir` is the directory where `zaps` was invoked. Use `cwd` to override this — useful when sharing a config across multiple projects:

```
workspace/
  customer/
    .zaps.mts          ← shared config
    customer-1/        ← run `zaps` here
    customer-2/        ← or here
```

**String** — resolved relative to the config file's directory:

```typescript
cwd: "./customer-1";
```

**Function** — receives `{ configDir, invokeDir }` for dynamic resolution:

```typescript
cwd: ({ invokeDir }) => invokeDir; // already the default
```

### Node Built-ins

The `Library` object includes a `node` namespace with common Node.js modules (`path`, `fs`, `process`, `url`, `os`, `child_process`) so configs don't need raw `import` statements:

```typescript
export function config({ defineProject, node }: Library) {
  return defineProject({
    cwd: ({ configDir }) => node.path.join(configDir, "backend"),
    services: {
      api: {
        start: "npm run dev",
        env: { HOME: node.process.env.HOME ?? "" },
      },
    },
  });
}
```

### Config Loading & Reload

Config files (`.zaps.ts` / `.zaps.mts` and their `local.` variants) are evaluated
with [jiti](https://github.com/unjs/jiti). Each load re-evaluates the **entire**
import graph — the entry file plus every relative helper/env file it imports — so
you can split config across modules and a reload picks up edits to any of them:

```typescript
// helper.mts
export const apiPort = 3000;

// .zaps.mts
import { apiPort } from "./helper.mts";
export function config(z) {
  /* use apiPort */
}
```

Caveats (consequences of jiti's per-load CJS transform):

- No ESM live bindings — exports are snapshotted at load time.
- Module identity changes per load: values from one load are not `===`/`instanceof`
  identical to the next. Don't rely on cross-reload object identity.
- `node_modules` reached from a config are re-evaluated on each load. If config load
  becomes slow because of a heavy dependency, that cost is per reload.

**Reloading a running session** is **validate-then-swap**: the new config is loaded and
validated first, and only swapped in if it parses cleanly. An invalid edit never tears
down the running session — the old config stays live and the load error is reported.
When ZAPS detects the config file changed on disk, the TUI header shows a
`config changed — press c to reload` hint; press **`c`** on the dashboard (while no
service is mid-operation) to apply it.

## Services

### Options

| Option          | Type                                        | Default | Description                                                                                   |
| --------------- | ------------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `start`         | `string \| () => string`                    | —       | Command to start the service                                                                  |
| `run`           | `string \| () => string`                    | —       | Alias for `start`                                                                             |
| `stop`          | `string \| () => string`                    | —       | Custom stop command (default: Ctrl-C)                                                         |
| `docker`        | `DockerConfig`                              | —       | Docker Compose service config                                                                 |
| `ready`         | `ReadyConfig`                               | —       | How to detect the service is ready                                                            |
| `dependsOn`     | `string[]`                                  | `[]`    | Services that must be ready first                                                             |
| `env`           | `Record<string, string> \| (ctx) => Record` | —       | Environment variables                                                                         |
| `cwd`           | `string`                                    | —       | Working directory                                                                             |
| `url`           | `string \| (ctx) => string`                 | —       | URL for browser open (`o` key)                                                                |
| `flags`         | `{ start?: boolean, open?: boolean }`       | —       | `start`: auto-start on launch (default `true`), `open`: auto-open URL when ready              |
| `detached`      | `boolean`                                   | `false` | Run outside tmux (no pane)                                                                    |
| `lazyPane`      | `boolean`                                   | _auto_  | Create the pane on start, drop it on explicit stop (default `true` when `flags.start: false`) |
| `raw`           | `boolean`                                   | `false` | Bypass wrapper — show env vars inline in pane                                                 |
| `restart`       | `{ maxRetries?, backoff? }`                 | —       | Auto-restart on crash                                                                         |
| `onBeforeStart` | `() => void \| Promise<void>`               | —       | Callback before command is sent                                                               |
| `onReady`       | `() => void \| Promise<void>`               | —       | Callback when service becomes ready                                                           |
| `onStop`        | `() => void \| Promise<void>`               | —       | Callback when service stops                                                                   |
| `onOutput`      | `(line: string) => void \| Promise<void>`   | —       | Called for each new output line                                                               |
| `optional`      | `boolean \| () => Promise<boolean>`         | —       | Mark service as optional (see below)                                                          |

### Optional Services

Mark services as optional when the binary may not be installed on all machines:

```typescript
services: {
  rainfrog: {
    optional: true,
    start: "rainfrog -u postgres://localhost:5432",
    ready: { port: 5432 },
  },
}
```

When `optional: true`, ZAPS checks if the binary exists via `command -v`. The binary is the first **non-assignment** token of `start`/`run`, so leading `FOO=bar` env-prefixes are skipped (`FOO=bar rainfrog …` probes `rainfrog`, not `FOO=bar`). A command with no real binary token (only assignments, or blank) is treated as **unavailable**. For function commands or custom checks, use the context helper:

```typescript
services: {
  rainfrog: {
    optional: (ctx) => ctx.hasBinary("rainfrog"),
    start: (ctx) => `rainfrog --url postgres://localhost:${ctx.services.db.ports[0]}`,
    dependsOn: ["db"],
  },
}
```

The `optional` predicate receives a context with helpers:

- `ctx.hasBinary(name)` — checks if a binary exists via `command -v`

Combine checks naturally:

```typescript
optional: async (ctx) => await ctx.hasBinary("grafana") && await ctx.hasBinary("prometheus"),
```

**Behavior when unavailable:**

- No tmux pane allocated
- Shown greyed out in TUI dashboard
- `dependsOn`/`restartWith` references silently dropped
- Layout automatically adjusts (empty splits collapsed)

> **Note:** `optional: true` requires `start` or `run` as a string (not a function). Use the function form with `ctx.hasBinary()` for function commands or docker-only services.

### Detached Services

Set `detached: true` to run a service **pane-less** — outside the tmux layout, with no
visible pane:

```typescript
services: {
  worker: {
    start: "node worker.js",
    detached: true,
    ready: { port: 4000 },
  },
}
```

- Full lifecycle still applies — start/stop/restart, ready detection, and crash
  recovery all work the same as a paned service.
- `zaps up -d` starts the whole session detached (services run, no TUI attached);
  `zaps attach` later to view it.
- **No tmux pane**, so there is no live terminal to scroll — read its output via the
  log buffer (`zaps logs worker`, `-f` to stream).
- A detached service **must not** appear in `layout`, and cannot be combined with
  `docker` or `raw` (both need a pane) — these are config load errors.

### Lazy Panes

A **lazy** service is one whose tmux pane only exists while the process is
running: the pane is created at its exact declared layout position when the
service is started, and destroyed when the service is **explicitly** stopped.
A crash keeps the pane (so you can inspect the post-mortem output); a restart
keeps the pane (the process is replaced in place). The first manual start
brings the pane in; the first manual stop takes it out.

```typescript
services: {
  mailpit: {
    start: "mailpit",
    flags: { start: false }, // No autostart — opt-in via `s` / TUI / CLI.
    ready: { port: 8025 },
  },
}
```

**Default rule:** `lazyPane: true` when the service is non-autostart
(`flags.start: false`); `lazyPane: false` for autostart services. An explicit
`lazyPane: true | false` always wins.

**Docker groups and detached services are never lazy** — even when
`flags.start: false` is set, a docker-group member keeps its shared group pane
and a `detached: true` service stays pane-less. The boot-skip rule applies to
own-pane services only, so the group/detached behavior is unchanged.

`lazyPane` is the lifecycle counterpart to [`detached`](#detached-services):
**detached** services are NEVER paned (no terminal at all), while **lazy**
services are paned **on demand** (a real pane appears at start and disappears
on explicit stop).

**Illegal combinations** (config load errors):

- `lazyPane: true` with `detached: true` — a detached service has no pane.
- `lazyPane: true` on a docker-group member (a service expanded from
  `docker.service: [...]` with `expand`) — group members share one pane, so
  per-member lazy is ambiguous; apply `lazyPane` at the group level once
  group-granularity lazy ships.

**Migration note.** Before this version, every non-autostart service got an
empty reserved tmux pane at boot. Non-autostart services now boot **pane-less**
by default. To keep the old behavior (an idle empty pane reserved at boot),
set `lazyPane: false` on the service.

### Ready Detection

Five strategies for detecting when a service is ready:

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

**HTTP** — poll an HTTP endpoint:

```typescript
ready: { http: "/health" }                              // path — auto-detects port, then probes
ready: { http: "http://localhost:3000/health" }          // full URL — probes directly
ready: { http: { url: "/api/health", status: 200 } }    // require specific status code
```

When the URL starts with `/`, ZAPS re-detects the service's ports every poll and probes the path on `http://127.0.0.1:{port}{path}`, skipping debugger/HMR ports (9229-9240, 24678). A full URL is probed directly. If `status` is omitted, any HTTP response counts as ready.

**Docker** — wait for container running + healthy:

```typescript
ready: { docker: "postgres" }
ready: { docker: ["postgres", "redis"] }  // all must be ready
ready: { docker: "postgres", file: "./docker-compose.yml" }
```

> **Docker + `ready.port` / path-`http` is a config load error.** Published docker
> ports are held by `dockerd`, not the service's pane, so port/PID detection can
> never match — it would always time out. Use the default docker readiness, or a
> full-URL `ready: { http: "http://127.0.0.1:<port>/path" }`.

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

| Option          | Type                                | Default | Description                                 |
| --------------- | ----------------------------------- | ------- | ------------------------------------------- |
| `service`       | `string \| string[]`                | —       | Docker Compose service name(s) (required)   |
| `file`          | `string`                            | —       | Path to compose file                        |
| `projectName`   | `string`                            | —       | Pin the compose project name (see below)    |
| `build`         | `boolean`                           | —       | `--build` flag                              |
| `forceRecreate` | `boolean`                           | —       | `--force-recreate` flag                     |
| `renewVolumes`  | `boolean`                           | —       | `-V` flag (recreate volumes)                |
| `removeOrphans` | `boolean`                           | —       | `--remove-orphans` flag                     |
| `pull`          | `"always" \| "missing" \| "never"`  | —       | `--pull` strategy                           |
| `noDeps`        | `boolean`                           | —       | `--no-deps` flag                            |
| `expand`        | `boolean \| Record<string, object>` | —       | Expand into individual services (see below) |

> **Compose version:** Docker Compose **v2.21+** is the tested baseline.

#### Compose project pinning

Every compose invocation is pinned to a deterministic project name so two
checkouts in same-named directories (e.g. `…/foo/backend` and `…/bar/backend`)
can't be mistaken for each other. The project name is resolved by precedence:

1. `docker.projectName` (this config field)
2. `ZAPS_COMPOSE_PROJECT` env var (read in the daemon process — set it where the daemon spawns)
3. the compose file's top-level `name:`
4. `zaps-<sanitized-dir-name>-<hash>` (default)

> **One-time recreate:** switching to a pinned project recreates the service's
> containers once. If containers already exist under the old (unpinned) name,
> ZAPS prints a one-time warning suggesting `docker compose -p <old> down`.

### Expanded Docker Services

When you have multiple Docker Compose services that can share a single tmux pane, use `expand: true` to split them into individually addressable services:

```typescript
services: {
  infra: {
    docker: {
      service: ["postgres", "redis", "mailpit"],
      expand: true,
    },
    restart: { maxRetries: 3 },
  },
  api: {
    start: "npm run dev",
    dependsOn: ["postgres"],  // reference individual expanded service
  },
}
```

This creates three individual services (`postgres`, `redis`, `mailpit`) that:

- Share a single tmux pane (one `docker compose up` command)
- Each have independent status, ready detection, and lifecycle
- Can be started/stopped/restarted individually
- Can be referenced individually in `dependsOn`
- Appear as grouped rows in the TUI dashboard

Layout references use the group name: `{ pane: "infra" }`.

Use `expand: { ... }` instead of `expand: true` to provide per-child overrides:

```typescript
services: {
  infra: {
    docker: {
      service: ["caddy", "postgres", "mailpit", "bugsink"],
      expand: {
        postgres: {
          onReady: () => runTask("prisma:deploy"),
        },
        bugsink: {
          ready: { http: "http://localhost:8000/health/ready" },
        },
      },
    },
  },
}
```

Children without overrides inherit the parent config. Overrides can set `ready`, `env`, `onReady`, `onStop`, `onBeforeStart`, `url`, `flags`, `restart`, etc.

An override **cannot** set `start`, `run`, or `docker` (the command and docker config are inherited from the parent group — overriding them would silently break the shared pane), and unknown keys (e.g. a typo like `redy:`) are rejected. Any forbidden or unknown key is a config load error naming the group, child, and offending key. `expand` also works when `service` is a single string (it expands to one child), not only on arrays.

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
      cwd: string | undefined; // service's configured cwd, else projectDir
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
  "interactive-migrate": {
    name: "Interactive migration",
    commands: "npx prisma migrate dev",
    popup: { width: "80%", height: "80%" },
  },
}
```

### Task Options

| Option        | Type                                             | Default | Description                                                     |
| ------------- | ------------------------------------------------ | ------- | --------------------------------------------------------------- |
| `name`        | `string`                                         | —       | Display name in the TUI                                         |
| `description` | `string`                                         | —       | Description shown in the task picker                            |
| `commands`    | `string \| string[]`                             | —       | Shell command(s) to run                                         |
| `run`         | `(ctx: TaskRunContext) => void \| Promise<void>` | —       | Programmatic task function (mutually exclusive with `commands`) |
| `cwd`         | `string`                                         | —       | Working directory                                               |
| `env`         | `Record<string, string>`                         | —       | Environment variables                                           |
| `dependsOn`   | `string[]`                                       | `[]`    | Tasks that must run first                                       |
| `shortcut`    | `string`                                         | —       | Hint key shown beside the task in the picker                    |
| `popup`       | `boolean \| { width?: string; height?: string }` | —       | Run in tmux popup window (commands only)                        |

Task dependencies are resolved and executed before the task itself.

### Programmatic Tasks

Use `run` instead of `commands` for full programmatic control:

```typescript
tasks: {
  "check-health": {
    name: "Health check",
    run: async ({ exec, stdout, services, projectDir }) => {
      const { success, output } = await exec("curl -sf http://localhost:3000/health");
      stdout.write(success ? "API healthy" : "API down");

      const result = await exec("npm test", { cwd: "./packages/api" });
      if (!result.success) throw new Error("Tests failed");
    },
  },
}
```

`TaskRunContext` shape:

```typescript
{
  exec(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult>;
  stdout: { write(text: string): void };
  services: ServiceContext;  // same as dynamic env context
  projectDir: string;
}
```

`ExecResult` shape:

```typescript
{
  success: boolean;
  exitCode: number;
  output: string[];
}
```

> `commands` and `run` are mutually exclusive — a task must use one or the other.

### Shortcuts

Tasks can define a `shortcut` key, shown as a hint beside the task in the picker.
If no shortcut is specified, ZAPS auto-assigns the first unique character from the
task key.

Press `t` on the dashboard to open the fuzzy task picker, then type to filter and
`Enter`/`Tab` to run (see [Task picker](#task-picker-t)).

#### Reserved keys

The keys **`q`, `j`, and `k` are reserved** and are never auto-assigned to a task (`q` detaches, `j`/`k` are list navigation). If a task explicitly requests one of them via `shortcut`, the shortcut is **dropped** (no fallback is assigned) and ZAPS prints a load-time warning:

```
Warning: task 'deploy' ('Deploy') requests reserved shortcut 'q'; 'q' is reserved (q=quit, j/k=navigation) and the shortcut is dropped.
```

Pick a different key for the task to keep a shortcut.

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
- `focus`: set to `true` on one leaf pane to auto-focus it after layout creation (at most one)
- Services not in the layout get their own background tmux window
- Detached services must **not** appear in the layout

If no layout is specified, `@tui` gets the main pane and each service gets a background window.

## TUI

The TUI is built around a dashboard, overlays (command palette, task picker, help,
failed-output), and a responsive layout that adapts to the pane size.

### Global keys

Work from any base view; survive a disconnect; yield to an open overlay.

| Key          | Action                                          |
| ------------ | ----------------------------------------------- |
| `Ctrl-K` `:` | Open the command palette (fuzzy actions)        |
| `?`          | Toggle the help overlay                         |
| `t`          | Open the task picker                            |
| `f`          | Open the captured output of the latest failure  |
| `x`          | Acknowledge — clear sticky failure toasts       |
| `q` `Ctrl-C` | Detach (services keep running)                  |
| `Ctrl-D`     | Shut down the session (stop services + destroy) |
| `Esc`        | Close the top overlay / leave the current view  |

### Dashboard

| Key           | Action                               |
| ------------- | ------------------------------------ |
| `Up/Down/j/k` | Navigate services                    |
| `r`           | Restart selected service             |
| `s`           | Start/stop selected service          |
| `l`           | View logs for selected service       |
| `o`           | Open service URL in browser          |
| `R`           | Docker rebuild (docker services)     |
| `z` / `Z`     | Zoom the service pane / the TUI pane |
| `E`           | Edit-capture the selected pane       |
| `a`           | Restart all services                 |
| `c`           | Reload config (when changed + idle)  |
| `t`           | Open the task picker                 |
| `d`           | Shut down the session                |

On wide panes a **detail pane** shows the selected service's fields; it collapses
when `cols < ui.wideThreshold` (default `100`). See [UI Config](#ui-config).

### Command palette (`Ctrl-K` / `:`)

| Key       | Action               |
| --------- | -------------------- |
| type      | Fuzzy-filter actions |
| `Up/Down` | Move selection       |
| `Enter`   | Run / confirm        |
| `Esc`     | Close                |

### Task picker (`t`)

Fuzzy picker over the project's tasks. Each task can run in two modes:

| Key       | Action                                                                |
| --------- | --------------------------------------------------------------------- |
| type      | Fuzzy-filter tasks                                                    |
| `Up/Down` | Move selection                                                        |
| `Enter`   | Run in the default mode (`ui.task.defaultMode`, default `background`) |
| `Tab`     | Run live in a tmux pane                                               |
| `Esc`     | Close                                                                 |

- **Background** runs stream into the daemon's retained output buffer; success
  shows a transient toast, failure a sticky one.
- **Run-in-pane** opens a tmux pane/window running the task live; the pane stays
  open on completion so the output stays inspectable.

Set `ui.task.popupPicker: true` to use an `fzf` tmux popup instead of the in-app
picker (falls back to the in-app picker when tmux < 3.2 or `fzf` is absent).

### Log view (`l`)

| Key           | Action            |
| ------------- | ----------------- |
| `Up/Down/j/k` | Scroll logs       |
| `Esc`         | Back to dashboard |

Scroll up to pause auto-follow; scroll back to the bottom to resume live tailing.

### Notifications & failed output

A finished background task raises an in-app toast: **success** is transient,
**failure** is sticky and stays until acknowledged with `x`. On failure ZAPS also
emits an out-of-band terminal notification per `ui.notifications` (default
`osc9`).

Press `f` to open the **failed-output overlay** for the latest sticky failure
(`Up/Down/j/k` scroll, `Esc` close). Inside it, `p` escalates to a larger tmux
`display-popup` (when tmux supports it). With `ui.failOutput: popup` the overlay
escalates straight to the popup on open.

## UI Config

The optional `ui` block tunes TUI presentation. Every field has a safe default,
so omitting `ui` (or any field) is fine.

```typescript
ui: {
  icons: "nerd",              // "nerd" | "unicode" | "ascii"
  notifications: "osc9",      // "off" | "bell" | "osc9" | "osc9+bell"
  failOutput: "overlay",      // "overlay" | "popup"
  wideThreshold: 100,         // min cols to show the detail pane (integer ≥ 40)
  task: {
    defaultMode: "background", // "background" | "pane" — Enter in the task picker
    popupPicker: false,        // open the task picker as an fzf tmux popup
  },
}
```

| Option             | Type                                       | Default        | Description                                                                                 |
| ------------------ | ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------- |
| `icons`            | `"nerd" \| "unicode" \| "ascii"`           | `"nerd"`       | Glyph tier. `ZAPS_ICONS` env overrides the config value.                                    |
| `notifications`    | `"off" \| "bell" \| "osc9" \| "osc9+bell"` | `"osc9"`       | Out-of-band failure notification channel (OSC 9 desktop notification and/or terminal bell). |
| `failOutput`       | `"overlay" \| "popup"`                     | `"overlay"`    | Where the `f` failed-output view opens; `popup` escalates straight to a tmux popup.         |
| `wideThreshold`    | `number` (int ≥ 40)                        | `100`          | Minimum terminal columns to show the detail pane; below it the pane collapses.              |
| `task.defaultMode` | `"background" \| "pane"`                   | `"background"` | Mode for `Enter` in the task picker (`Tab` always runs in a pane).                          |
| `task.popupPicker` | `boolean`                                  | `false`        | Use an `fzf` tmux popup picker instead of the in-app one (falls back when unavailable).     |

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
| `unavailable`                          | Gray `○`       |

## Hooks

### Global Hooks

Lifecycle hooks for custom logic at the project level:

```typescript
hooks: {
  onBeforeStart: async () => { /* runs once before any service starts */ },
  onStart: async () => { /* all services started */ },
  onStop: async () => { /* cleanup before exit */ },
}
```

### Per-Service Hooks

Services also support their own hooks for service-specific logic:

```typescript
services: {
  api: {
    start: "npm run dev",
    onBeforeStart: () => console.log("Setting up API"),
    onReady: () => console.log("API is up"),
    onStop: () => console.log("API stopped"),
    onOutput: (line) => {
      if (/error/i.test(line)) sendAlert(line);
    },
  },
}
```

## AI Integration

ZAPS offers two integration paths for AI coding agents: **Claude Code Skills** (recommended) and **MCP**. Skills are more token-efficient since they load context on-demand, while MCP provides a protocol-level interface usable by any MCP-compatible client.

### Agent Priming

Use `zaps prime-agent` to get a concise TOON overview of all services (with runtime state and ports) and tasks. Useful for bootstrapping an AI agent's context about the current project.

### Claude Code Skills

ZAPS ships two [Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills) in `.claude/skills/`:

| Skill         | Description                                                                  |
| ------------- | ---------------------------------------------------------------------------- |
| `zaps-usage`  | Interact with dev sessions — start/stop services, run tasks, view logs       |
| `zaps-config` | Author and edit ZAPS config files (`.zaps.mts`, `.zaps.ts`, `local.zaps.ts`) |

Skills are **recommended over MCP** because they load reference docs on-demand rather than occupying persistent context, resulting in significantly lower token usage.

#### Installation

Copy the `.claude/skills/` directory into your project:

```bash
cp -r node_modules/zaps/.claude/skills/ .claude/skills/
```

Claude Code will automatically discover and use the skills when relevant.

### MCP Server

ZAPS exposes an [MCP](https://modelcontextprotocol.io/) server that lets AI agents manage services, run tasks, and read logs.

```bash
zaps mcp                   # auto-detects session from CWD
zaps mcp --session my-app  # target specific session
```

#### Available Tools

| Tool                   | Description                          |
| ---------------------- | ------------------------------------ |
| `services_list`        | List all services and their statuses |
| `services_details`     | Get details for a specific service   |
| `services_start`       | Start a service                      |
| `services_stop`        | Stop a service                       |
| `services_restart`     | Restart a service                    |
| `services_start_all`   | Start all (or specific) services     |
| `services_stop_all`    | Stop all (or specific) services      |
| `services_restart_all` | Restart all (or specific) services   |
| `logs_snapshot`        | Get recent log lines for a service   |
| `tasks_list`           | List available tasks                 |
| `tasks_run`            | Run a task and return its output     |

#### Resources

| URI                         | Description                    |
| --------------------------- | ------------------------------ |
| `zaps://logs/{serviceName}` | Live log output (subscribable) |

#### Claude Code Setup

```bash
claude mcp add zaps -- zaps mcp
```

Or manually add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "zaps": {
      "command": "zaps",
      "args": ["mcp"]
    }
  }
}
```

### CLAUDE.md Setup

Add the following to your project's `CLAUDE.md` to help Claude use ZAPS effectively:

```markdown
## ZAPS

- Use the `zaps-usage` skill to manage dev sessions (start/stop services, run tasks, view logs)
- Use the `zaps-config` skill when editing ZAPS config files
```

## Troubleshooting & Migration

### `zaps daemon stop` tears down services

`zaps daemon stop` now performs a **full cleanup**: it stops every service in every
session the daemon manages before shutting the daemon down, and reports what it tore
down (`Stopped <n> session(s), <m> service(s).`). It is no longer a bare process kill.

### Error messages you may see

- **Port already in use** — before starting a service, ZAPS pre-flights its expected
  host ports. If one is taken it fails fast with an attributed message instead of
  letting the service crash on bind:

  ```
  Port 5432 already in use (pid 1234 postgres)
  ```

- **Dependency not ready** — when a service can't start because one of its
  `dependsOn` services never became ready, the dependent's `lastError` (shown in the
  dashboard) reads:

  ```
  Dependency "db" not ready
  ```

### Removed environment variables

`ZAPS_PANE_MAP` and `ZAPS_IPC_SOCKET` have been **removed**. These legacy env paths
never functioned and there is no migration — delete any references to them. Pane and
socket resolution is handled internally by the daemon.

### Compose project pinning (one-time)

Upgrading pins every compose invocation to a deterministic `-p` project name (see
[Compose project pinning](#compose-project-pinning)). Existing containers started under
the old, unpinned project name keep running but are no longer tracked. Clean them up
once per affected project directory:

```bash
docker compose -p <old-project-name> down
```

ZAPS prints a best-effort one-time warning when it detects such leftover containers.

## License

MIT
