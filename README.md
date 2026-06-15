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
  });
}
```

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

## Services

### Options

| Option          | Type                                        | Default | Description                                                                      |
| --------------- | ------------------------------------------- | ------- | -------------------------------------------------------------------------------- |
| `start`         | `string \| () => string`                    | —       | Command to start the service                                                     |
| `run`           | `string \| () => string`                    | —       | Alias for `start`                                                                |
| `stop`          | `string \| () => string`                    | —       | Custom stop command (default: Ctrl-C)                                            |
| `docker`        | `DockerConfig`                              | —       | Docker Compose service config                                                    |
| `ready`         | `ReadyConfig`                               | —       | How to detect the service is ready                                               |
| `dependsOn`     | `string[]`                                  | `[]`    | Services that must be ready first                                                |
| `env`           | `Record<string, string> \| (ctx) => Record` | —       | Environment variables                                                            |
| `cwd`           | `string`                                    | —       | Working directory                                                                |
| `url`           | `string \| (ctx) => string`                 | —       | URL for browser open (`o` key)                                                   |
| `flags`         | `{ start?: boolean, open?: boolean }`       | —       | `start`: auto-start on launch (default `true`), `open`: auto-open URL when ready |
| `detached`      | `boolean`                                   | `false` | Run outside tmux (no pane)                                                       |
| `raw`           | `boolean`                                   | `false` | Bypass wrapper — show env vars inline in pane                                    |
| `restart`       | `{ maxRetries?, backoff? }`                 | —       | Auto-restart on crash                                                            |
| `onBeforeStart` | `() => void \| Promise<void>`               | —       | Callback before command is sent                                                  |
| `onReady`       | `() => void \| Promise<void>`               | —       | Callback when service becomes ready                                              |
| `onStop`        | `() => void \| Promise<void>`               | —       | Callback when service stops                                                      |
| `onOutput`      | `(line: string) => void \| Promise<void>`   | —       | Called for each new output line                                                  |
| `optional`      | `boolean \| () => Promise<boolean>`         | —       | Mark service as optional (see below)                                             |

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

When `optional: true`, ZAPS checks if the binary exists (first word of `start`/`run` via `command -v`). For function commands or custom checks, use the context helper:

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

When the URL starts with `/`, ZAPS first waits for a port (like `port: true`) then probes `http://localhost:{port}{path}`. A full URL is probed directly. If `status` is omitted, any HTTP response counts as ready.

**Docker** — wait for container running + healthy:

```typescript
ready: { docker: "postgres" }
ready: { docker: ["postgres", "redis"] }  // all must be ready
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

| Option          | Type                               | Default | Description                                 |
| --------------- | ---------------------------------- | ------- | ------------------------------------------- |
| `service`       | `string \| string[]`               | —       | Docker Compose service name(s) (required)   |
| `file`          | `string`                           | —       | Path to compose file                        |
| `build`         | `boolean`                          | —       | `--build` flag                              |
| `forceRecreate` | `boolean`                          | —       | `--force-recreate` flag                     |
| `renewVolumes`  | `boolean`                          | —       | `-V` flag (recreate volumes)                |
| `removeOrphans` | `boolean`                          | —       | `--remove-orphans` flag                     |
| `pull`          | `"always" \| "missing" \| "never"` | —       | `--pull` strategy                           |
| `noDeps`        | `boolean`                          | —       | `--no-deps` flag                            |
| `expand`        | `boolean`                          | —       | Expand into individual services (see below) |

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
| `description` | `string`                                         | —       | Description shown in tasks view                                 |
| `commands`    | `string \| string[]`                             | —       | Shell command(s) to run                                         |
| `run`         | `(ctx: TaskRunContext) => void \| Promise<void>` | —       | Programmatic task function (mutually exclusive with `commands`) |
| `cwd`         | `string`                                         | —       | Working directory                                               |
| `env`         | `Record<string, string>`                         | —       | Environment variables                                           |
| `dependsOn`   | `string[]`                                       | `[]`    | Tasks that must run first                                       |
| `shortcut`    | `string`                                         | —       | Key for chord mode quick execution                              |
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
- `focus`: set to `true` on one leaf pane to auto-focus it after layout creation (at most one)
- Services not in the layout get their own background tmux window
- Detached services must **not** appear in the layout

If no layout is specified, `@tui` gets the main pane and each service gets a background window.

## TUI Keyboard Shortcuts

### Dashboard

| Key           | Action                         |
| ------------- | ------------------------------ |
| `Up/Down/j/k` | Navigate services              |
| `r`           | Restart selected service       |
| `s`           | Start/stop selected service    |
| `l`           | View logs for selected service |
| `o`           | Open service URL in browser    |
| `t`           | Tasks (chord mode or list)     |
| `a`           | Restart all services           |
| `q`           | Stop all and quit              |

### Chord Mode

Shown when any task has a shortcut. Press a shortcut key to run it, `Esc` to cancel, `Enter` or any unmatched key to open the tasks list.

### Tasks View

| Key           | Action                   |
| ------------- | ------------------------ |
| `Up/Down/j/k` | Navigate tasks           |
| `Enter`       | Run selected task        |
| `[key]`       | Run task by shortcut key |
| `Esc`         | Back to dashboard        |

The tasks view shows the last 10 task runs with a result icon and relative timestamp. The dashboard footer also displays the 3 most recent task runs.

### Log View

| Key           | Action            |
| ------------- | ----------------- |
| `Up/Down/j/k` | Scroll logs       |
| `Esc`         | Back to dashboard |

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

## License

MIT
