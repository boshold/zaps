<div align='center'>
   <p>

<img src="https://raw.githubusercontent.com/boshold/zaps/main/assets/banner.png" alt="ZAPS" width="600">

   <p>
      <a href="https://www.npmjs.com/package/@bosdev/zaps">
         <picture>
            <source media="(prefers-color-scheme: dark)" type="image/svg+xml" srcset="https://img.shields.io/npm/v/@bosdev/zaps?logo=npm&label=npm&color=f38ba8&labelColor=313244&logoColor=f38ba8">
            <img alt="npm version" src="https://img.shields.io/npm/v/@bosdev/zaps?logo=npm&label=npm&color=d20f39&labelColor=ccd0da&logoColor=d20f39"/>
         </picture>
      </a>
      <a href="https://nodejs.org">
         <picture>
            <source media="(prefers-color-scheme: dark)" type="image/svg+xml" srcset="https://img.shields.io/node/v/@bosdev/zaps?logo=nodedotjs&label=node&color=a6e3a1&labelColor=313244&logoColor=a6e3a1">
            <img alt="Node engine" src="https://img.shields.io/node/v/@bosdev/zaps?logo=nodedotjs&label=node&color=40a02b&labelColor=ccd0da&logoColor=40a02b"/>
         </picture>
      </a>
      <a href="https://github.com/boshold/zaps/actions/workflows/ci.yml">
         <picture>
            <source media="(prefers-color-scheme: dark)" type="image/svg+xml" srcset="https://img.shields.io/github/actions/workflow/status/boshold/zaps/ci.yml?branch=main&logo=githubactions&label=ci&color=89b4fa&labelColor=313244&logoColor=89b4fa">
            <img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/boshold/zaps/ci.yml?branch=main&logo=githubactions&label=ci&color=1e66f5&labelColor=ccd0da&logoColor=1e66f5"/>
         </picture>
      </a>
      <a href="https://github.com/boshold/zaps/blob/main/LICENSE">
         <picture>
            <source media="(prefers-color-scheme: dark)" type="image/svg+xml" srcset="https://img.shields.io/github/license/boshold/zaps.svg?color=cba6f7&labelColor=313244">
            <img src="https://img.shields.io/github/license/boshold/zaps.svg?color=8839ef&labelColor=ccd0da" alt="MIT License"/>
         </picture>
      </a>
      <a href="https://github.com/tmux/tmux/wiki#-is-awesome">
         <picture>
            <source media="(prefers-color-scheme: dark)" type="image/svg+xml" srcset="https://img.shields.io/badge/%3E%3D3.5-94e2d5?logo=tmux&label=tmux&labelColor=313244&logoColor=94e2d5">
            <img alt="Tmux >= 3.5" src="https://img.shields.io/badge/%3E%3D3.5-179299?logo=tmux&label=tmux&labelColor=ccd0da&logoColor=179299">
         </picture>
       </a>
   </p>
   <hr>
   <p>
      <h3>⚡ Painless project setup ⚡</h3>
      <div>Zero Ass Pain Setup. Run dev services with tmux panes or a background shell backend and an interactive TUI.</div>
      <div>Define services, dependencies, tasks, and layout in one config file. ZAPS manages service lifecycle, readiness, restart policy, logs, and a keyboard-driven dashboard.</div>
   </p>
</div>

## Demo

<img src="https://raw.githubusercontent.com/boshold/zaps/main/assets/demo.gif" alt="ZAPS terminal demo" width="900">

## Prerequisites

- Linux or macOS, with `ps` and `ss` on Linux or `lsof` on macOS for PID-based port detection.
- [tmux](https://github.com/tmux/tmux/wiki#-is-awesome) >= 3.5 for the tmux backend. The shell backend needs no tmux installation.
- An interactive terminal on both stdin and stdout to open the UI. Use `-b` for noninteractive startup.

Shell services and background task commands use noninteractive `sh` semantics.
Interactive input, a PTY, and Bash-specific syntax are not provided by the shell
backend. Run an explicit interpreter such as `bash script.sh` when needed.

## Install

### Package install (Node >= 22.15)

```bash
pnpm add -g @bosdev/zaps
```

The package name is `@bosdev/zaps`; the installed command is `zaps`. The native
binary for your platform (`linux`/`darwin`, `x64`/`arm64`) is installed
automatically as an optional dependency and used when present; otherwise the
bundled Node build runs.

### Prebuilt binary (no Node required)

Download the asset for your platform from the
[latest release](https://github.com/boshold/zaps/releases/latest)
(`zaps-linux-x64`, `zaps-linux-arm64`, `zaps-darwin-x64`, `zaps-darwin-arm64`),
then make it executable and put it on your `PATH`:

```bash
# Example: Linux x64
curl -fsSL -o zaps https://github.com/boshold/zaps/releases/latest/download/zaps-linux-x64
chmod +x zaps
sudo mv zaps /usr/local/bin/zaps
```

Optionally verify the download against `SHA256SUMS` from the same release:

```bash
curl -fsSL -O https://github.com/boshold/zaps/releases/latest/download/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```

## Quick Start

```bash
zaps init          # Scaffold .zaps.mts config
# Edit .zaps.mts to define your services
zaps               # Launch
```

Run `zaps` from an interactive terminal to start services and open the dashboard.
New sessions use tmux by default; ZAPS creates a managed tmux session when needed.

## Backends and background sessions

Start without tmux, then open the same session's UI:

```bash
zaps -b && zaps
```

`-b` / `--background` starts a new shell session, waits for the startup/readiness
result, and returns. The daemon owns its services, so they keep running after the
launching command or terminal closes. The second command opens the UI directly
in your terminal without restarting services or invoking tmux. `zaps attach` also
opens an existing session's UI.

Backend selection applies when creating a session. Without `-B`, later startup
reuses its stored backend, including when `-b` is present. An explicit conflicting
backend fails with `backend_conflict`; run `zaps down` before switching. There is
no saved backend preference, config field, or automatic fallback when tmux is
missing. The startup command matrix is in [Lifecycle](#lifecycle).

### Quit and shutdown

`q` or `Ctrl-C` leaves the UI while services and ordinary background tasks keep
running. Run `zaps` again to reopen it. `Ctrl-D` requests shutdown and asks for `y`
confirmation; `zaps down` stops owned resources and destroys the selected session.

A managed tmux UI detaches only when exactly one outer client can be verified for
its dashboard. With ambiguous or unverifiable client ownership, it stays open and
shows a manual-detach hint. Use your tmux detach command, or target the correct
managed session yourself. A UI inside your own tmux unsubscribes without detaching
that host. Configured hook popups follow their client lifetime and may fail when
that client detaches; ordinary background tasks continue.

The UI reports shutdown failures it receives. Managed teardown can remove the
dashboard pane before a later cleanup-error response arrives, so that pane cannot
always display the final result. A surviving CLI request can report its explicit
destruction result.

Service and task logs are retained in daemon memory. Closing the UI does not
clear them; destroying the session or losing the daemon loses that history.
Services do not survive daemon failure, and ZAPS does not adopt orphaned processes
or restore session state. After cleanup, start a new session explicitly.

### Environment and session location

Each ZAPS command sends its current directory and shell environment to the daemon.
Services started by that command use the same environment even when the daemon or
managed tmux server started from another project.

ZAPS also loads `.env` from the resolved project directory. Precedence is:

1. Project `.env`
2. Current shell environment
3. Service or task `env`

The later source wins. A later start, stop, restart, task, or reload command updates
the stored environment for that session. Already running processes keep their old
environment until they restart. The daemon keeps separate context for each project
and never changes its own working directory.

`zaps ls` shows the stored backend and location. Shell sessions have no tmux
location; tmux sessions show their host and whether ZAPS manages it.

### Tmux sessions

For a new tmux session, `zaps` uses your current tmux host when invoked inside one.
From a normal terminal it creates a managed session on a separate tmux server.
Existing personal/managed tmux sessions retain their attach-context restrictions;
ZAPS prints a hint when the caller's context is incompatible. Selecting shell
ignores ambient tmux variables and never starts tmux.

Set `ZAPS_AUTO_TMUX=0` to disable automatic managed-tmux startup. This affects tmux
sessions only; `zaps -b` and `zaps -B shell` still select shell for a new session.

## Commands

### Lifecycle

| Command                                  | New-session backend | Initial UI                |
| ---------------------------------------- | ------------------- | ------------------------- |
| `zaps` / `zaps up`                       | tmux                | Open                      |
| `zaps -b` / `zaps up --background`       | shell               | None                      |
| `zaps -B shell` / `zaps --backend shell` | shell               | Open in invoking terminal |
| `zaps -b -B tmux`                        | tmux                | None                      |
| `zaps up -d`                             | tmux                | None; legacy detach flag  |
| `zaps up -d -B shell`                    | shell               | None                      |

These backend defaults apply only to new sessions. Existing sessions keep their
backend unless an explicit mismatch is rejected. `-b` and `-B` apply only to root
startup or `up`; explicit `-B` wins regardless of flag order. The legacy `-d` flag
belongs after `up`, not at the root. Background startup suppresses the UI even
when an explicit backend is supplied.

Use `zaps attach` to open an existing session and `zaps down` to stop its services
and destroy it. UI startup rejects redirected stdin or stdout before creating a
session or printing terminal escapes; background startup does not require a TTY.

### Service Operations

| Command                     | Description                        |
| --------------------------- | ---------------------------------- |
| `zaps start [service...]`   | Start service(s). All if omitted   |
| `zaps stop [service...]`    | Stop service(s). All if omitted    |
| `zaps restart [service...]` | Restart service(s). All if omitted |

### Query

| Command                  | Description                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `zaps ps`                | List services with state, ports, URL; `ERRORS` (Sentra errors since start) when Sentra is enabled. `--json` |
| `zaps ls`                | List active sessions. `--json`                                                                              |
| `zaps inspect <service>` | Show service details. `--json`                                                                              |

### Tasks & Logs

| Command                  | Description                                                      |
| ------------------------ | ---------------------------------------------------------------- |
| `zaps run <task>`        | Run a task. Streams output. `--json`                             |
| `zaps tasks`             | List configured tasks. `--json`                                  |
| `zaps logs [service...]` | Dump log buffer. `-f` to stream live. `--tail <n>` (default 100) |
| `zaps events`            | Stream daemon events as ndjson. `--filter <type>`                |

### Sentry Errors

Needs [Sentra](#sentry-errors-sentra) set up in the config.

| Command                 | Description                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `zaps sentra errors`    | List error events, newest first. Time, filter and paging flags, `--fail-if-any`, `--json`                               |
| `zaps sentra issues`    | List grouped issues, last seen first. `--service`, `--level`, `--min-level`, `--q`, time and paging flags, `--json`     |
| `zaps sentra show <id>` | Show one record, issue, or Sentry event id as Markdown. `--json`                                                        |
| `zaps sentra live`      | Stream new records until Ctrl-C. `--service`, `--level`, `--min-level`, `--kind` (error, message, log), `--q`, `--json` |
| `zaps sentra clear`     | Delete the session's records. `--service`, `--before <time>`, `--json`                                                  |

### Config & Setup

| Command                                 | Description                                                           |
| --------------------------------------- | --------------------------------------------------------------------- |
| `zaps config`                           | Validate and print resolved config. `--json`, `--toon`, `--path`      |
| `zaps reload`                           | Reload config for the running session (CLI form of the dashboard `c`) |
| `zaps init`                             | Scaffold a starter `.zaps.mts` config                                 |
| `zaps attach`                           | Attach TUI to a running session (use `-s` to choose one)              |
| `zaps daemon start\|stop\|status\|ping` | Daemon management (`ping` checks the daemon is responsive)            |

### Selecting a session & output format

- **`-s, --session <id\|name>`** is a global flag (place it before the command): `zaps -s my-app attach`, `zaps -s my-app down`. It matches by exact id, exact name, then id/name prefix. When omitted, ZAPS resolves the session for the current directory; if several match it lists them and asks you to disambiguate.
- **Output format** — query/service commands print a human table by default. Pass `--json` (pretty JSON) or `--toon` ([TOON](https://github.com/toon-format/toon)) for machine output, or set `ZAPS_FORMAT=json|toon` to make it the default. Coding agents (detected via `CLAUDECODE` / `CURSOR_TRACE_DIR`) default to TOON automatically.

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
import type { Library } from "@bosdev/zaps";

export function config({ define }: Library) {
  return define({
    services: {
      api: {
        start: "npm run dev",
        ready: { port: 3000 },
      },
    },
  });
}
```

The config function receives the `Library` object, which groups everything into
namespaces: `define`, `find`, `cli`, `task`, `service`, `browser`, and `node`.
Destructure just the pieces you use. See [Library API](#library-api) for the full
reference. The function may be **async** — declare it
`export async function config(lib) { … }` (the result is awaited).

### Full Config Reference

```typescript
import type { Library } from "@bosdev/zaps";

export function config({ define }: Library) {
  return define({
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

**`find.up(filename, opts?)`** — walk upward from the invoke directory to the first
directory containing `filename`, and use that as `cwd`. Handy for monorepos where you
run `zaps` from a nested package but want the project root:

```typescript
export function config({ define, find }) {
  return define({
    cwd: find.up("package.json"),
    services: {/* … */},
  });
}
```

Options:

- `stopAt` — stop the walk at a boundary: an absolute path, or the literal `"config"`
  to stop at the config file's directory. `cwd: find.up("package.json", { stopAt: "config" })`.
- `orFatal` — the message used if `filename` is never found:
  `cwd: find.up("Cargo.toml", { orFatal: "Run zaps inside a Rust crate" })`.

`find.up` always returns a resolver (never `null`). If the file isn't found, it throws a
`ConfigError` when the config loads — there's no `?? cli.fatal()` to write. See
[Error Model](#error-model).

The resolved directory also identifies the daemon session. One shared config can
therefore run several project directories at the same time. Project `cwd` cannot
depend on a value that only exists in that project's `.env`, because ZAPS must know
the project directory before it can load the file.

### Node Built-ins

The `Library` object includes a `node` namespace with common Node.js modules (`path`, `fs`, `process`, `url`, `os`, `child_process`) so configs don't need raw `import` statements:

```typescript
export function config({ define, node }: Library) {
  return define({
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

## Library API

The `Library` object passed to your `config` function groups everything into
namespaces. Destructure what you need: `config(({ define, find, cli, service }) => …)`.

| Namespace | Member                           | Description                                                                 |
| --------- | -------------------------------- | --------------------------------------------------------------------------- |
| `define`  | `(config) => config`             | Validate and return the project config. Throws `ConfigError` on bad config. |
| `find`    | `up(filename, opts?)`            | Build a `cwd` resolver that walks upward (see [`cwd`](#cwd)).               |
| `cli`     | `fatal(message, opts?)`          | Abort config eval by throwing a `ConfigError`. Never returns.               |
| `cli`     | `warn / info / success(message)` | Emit a notice (stderr in the CLI; a TUI toast during a daemon reload).      |
| `task`    | `run(key)`                       | Run a named task. Only available inside service hooks.                      |
| `service` | `start / stop / restart(name)`   | Control a service. Only available inside service hooks.                     |
| `service` | `isRunning(name)`                | Whether a service is currently ready. Hooks only.                           |
| `browser` | `open(url)`                      | Open a URL in the default browser.                                          |
| `node`    | `path / fs / process / …`        | Common Node.js modules, no `import` needed.                                 |

`task.*` and `service.*` are only wired up while a session is running, so call them
from hooks (e.g. `onReady`), not at the top level of `config`. Calling them too early
throws a clear error.

```typescript
export function config({ define, cli, service }) {
  return define({
    services: {
      api: {
        start: "npm run dev",
        ready: { port: 3000 },
        env: { API_KEY: process.env.API_KEY ?? cli.fatal("API_KEY is required") },
      },
      worker: {
        run: "npm run worker",
        onReady: () => service.restart("api"),
      },
    },
  });
}
```

### Error Model

Config-eval failures **throw** a `ConfigError` rather than calling `process.exit`.
This keeps the daemon safe:

- **In-process loads** (`zaps config`) render a styled `✖ <message>` line and exit
  non-zero.
- **Daemon-path commands** (`zaps up`, `start`, …) report the same message **unstyled**
  and exit non-zero.
- **During a daemon reload**, a thrown `ConfigError` is caught: the running session is
  left fully intact (validate-then-swap), the old config stays live, and the error is
  reported — it never tears down your services.

`cli.fatal(message, opts?)` is the explicit escape hatch — it throws a `ConfigError`
with your message (and optional `field`). Because it returns `never`, it composes in any
value position: `name: pkg.name ?? cli.fatal("name required")`.

### Config Notices

`cli.warn`, `cli.info`, and `cli.success` surface a short message without aborting:

- In a one-shot CLI run they print a styled line to stderr.
- During a daemon reload (with the TUI attached) they appear as transient toasts.

```typescript
export function config({ define, cli }) {
  if (!process.env.STRIPE_KEY) cli.warn("STRIPE_KEY unset — payments disabled");
  return define({ services: { app: { start: "npm run dev" } } });
}
```

### Async Config

The config function may be `async`:

```typescript
export async function config({ define, node }) {
  const pkg = JSON.parse(await node.fs.promises.readFile("package.json", "utf8"));
  return define({ name: pkg.name, services: { app: { start: "npm run dev" } } });
}
```

Async evaluation is bounded by a 30-second timeout: if an async config hangs (awaiting
something that never resolves), the load fails with a `ConfigError` instead of blocking
a reload forever. The timeout only covers async waits — a synchronous infinite loop
isn't interruptible.

## Services

### Options

| Option          | Type                                         | Default | Description                                                                                               |
| --------------- | -------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `start`         | `string \| () => string`                     | —       | Command to start the service (long-running process)                                                       |
| `run`           | `string \| () => string`                     | —       | Interchangeable with `start` — either satisfies the "needs a command" rule (`start` wins if both are set) |
| `stop`          | `string \| () => string`                     | —       | Reserved; accepted by config but not executed                                                             |
| `docker`        | `DockerConfig`                               | —       | Docker Compose service config                                                                             |
| `ready`         | `ReadyConfig`                                | —       | How to detect the service is ready                                                                        |
| `dependsOn`     | `string[]`                                   | `[]`    | Services that must be ready first                                                                         |
| `env`           | `Record<string, string> \| (ctx) => Record`  | —       | Environment variables                                                                                     |
| `cwd`           | `string`                                     | —       | Working directory                                                                                         |
| `url`           | `string \| (ctx) => string`                  | —       | URL for browser open (`o` key)                                                                            |
| `flags`         | `{ start?: boolean, open?: boolean }`        | —       | `start`: auto-start on launch (default `true`), `open`: auto-open URL when ready                          |
| `detached`      | `boolean`                                    | `false` | Run outside tmux (no pane)                                                                                |
| `lazyPane`      | `boolean`                                    | _auto_  | Create the pane on start, drop it on explicit stop (default `true` when `flags.start: false`)             |
| `raw`           | `boolean`                                    | `false` | Bypass the service wrapper; requires tmux, rejected by shell                                              |
| `restart`       | `{ maxRetries?, backoff? }`                  | —       | Auto-restart on crash                                                                                     |
| `onBeforeStart` | `() => void \| Promise<void>`                | —       | Callback before command is sent                                                                           |
| `onReady`       | `() => void \| Promise<void>`                | —       | Callback when service becomes ready                                                                       |
| `onStop`        | `() => void \| Promise<void>`                | —       | Post-exit cleanup hook; not a graceful stop command                                                       |
| `onOutput`      | `(line: string) => void \| Promise<void>`    | —       | Called for each new output line                                                                           |
| `optional`      | `boolean \| () => Promise<boolean>`          | —       | Mark service as optional (see below)                                                                      |
| `sentra`        | `boolean \| { env: Record<string, string> }` | —       | Send Sentry SDK errors to ZAPS (see [Sentry Errors](#sentry-errors-sentra))                               |

`stop` is reserved and unimplemented. Normal stop signals the owned process and
uses bounded cleanup; `onStop` runs after exit and cannot send a graceful command
before termination.

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

Set `detached: true` to run a service without a pane in the tmux backend:

```typescript
services: {
  worker: {
    start: "node worker.js",
    detached: true,
    ready: { port: 4000 },
  },
}
```

- Service controls, readiness, and configured crash retries work as for a paned service.
- `zaps up -d` starts the whole session detached (services run, no TUI attached);
  `zaps attach` later to view it.
- **No tmux pane**, so there is no live terminal to scroll — read its output via the
  log buffer (`zaps logs worker`, `-f` to stream).
- A detached service must not appear in `layout`. Config validation also rejects
  combining `detached` with `docker` or `raw`.

Shell sessions run every service without a pane, whether or not `detached` is set.
Valid layout and lazy-pane preferences have no presentation effect there;
`flags.start` still controls autostart. Existing config validation remains active,
and `raw: true` is rejected before any shell session is created or reloaded.

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
2. `ZAPS_COMPOSE_PROJECT` env var from the current ZAPS command
3. the compose file's top-level `name:`
4. `zaps-<sanitized-dir-name>-<hash>` (default)

> **One-time recreate:** switching to a pinned project recreates the service's
> containers once. If containers already exist under the old (unpinned) name,
> ZAPS prints a one-time warning suggesting `docker compose -p <old> down`.

> **Tasks don't inherit the pin.** Pinning is applied only to the compose commands
> ZAPS runs for `docker` **services**. A task that shells out to bare `docker compose …`
> runs under Compose's own default project name, so it won't see the containers ZAPS
> started. Pass the project explicitly — `docker compose -p "$ZAPS_COMPOSE_PROJECT" …`
> (set `ZAPS_COMPOSE_PROJECT` where the daemon spawns) — or operate logically (e.g.
> `prisma migrate reset` instead of `docker compose down -v`).

### Expanded Docker Services

Use `expand: true` to address members of one shared Docker Compose execution individually. Tmux presents the group in one pane; shell runs it in the daemon:

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

- Share one attached `docker compose up` execution and one log producer
- Each have independent status, ready detection, and lifecycle
- Can be started/stopped/restarted individually
- Can be referenced individually in `dependsOn`
- Appear as grouped rows in the TUI dashboard

Layout references use the group name: `{ pane: "infra" }`.

Plain member start/stop/restart preserves the shared execution while siblings
remain active, including when controlling the launch-owner member. The last
active member stops the shared execution. Readiness for plain start/restart
accepts healthy unchanged container IDs even if initial build/recreate flags are
configured. Shared logs continue for attached siblings; Compose may stop streaming
a member's output after that member is restarted.

Explicit rebuild of any combined-group member returns `unsupported_config` before
changing config, status, containers, execution, or logs, including requests with
empty overrides. The UI hides/disables these rebuild actions. Standalone Docker
rebuild remains supported; full group recreation is deferred. Initial group
launch keeps the configured member set and existing build/recreate behavior. An
initial build that reuses an unchanged image may still wait for a new container ID;
plain member operations do not have that recreation expectation.

Use `expand: { ... }` instead of `expand: true` to provide per-child overrides:

```typescript
services: {
  infra: {
    docker: {
      service: ["caddy", "postgres", "mailpit", "bugsink"],
      expand: {
        postgres: {
          onReady: () => task.run("prisma:deploy"),
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

### Service crash retries

Enable auto-restart with exponential backoff:

```typescript
restart: {
  maxRetries: 5,    // default: 3
  backoff: 2000,    // base delay in ms, default: 1000
}
```

Backoff doubles per retry: 2s, 4s, 8s, 16s, then 32s. The shared manager applies
the configured restart policy to both backends. These retries require a running
daemon; they do not restore services after daemon failure.

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
  url(service: string, opts?: UrlOptions): string | null;
}
```

### `ctx.url()`

`ctx.url(service, opts?)` builds a URL from a service's detected port, so you don't
have to hand-assemble strings:

```typescript
env: (ctx) => ({
  API_URL: ctx.url("api"), // "http://localhost:3000"
  DATABASE_URL: ctx.url("db", { protocol: "postgres", auth: "user:pass", path: "/mydb" }),
  // → "postgres://user:pass@localhost:5432/mydb"
});
```

`UrlOptions`: `protocol` (default `"http"`), `auth` (e.g. `"user:pass"`), `host`
(default `"localhost"`), `port` (override the detected port), `path` (a leading `/` is
added if missing). IPv6 hosts are bracketed automatically (`http://[::1]:3000`).

Behavior:

- **Unknown service** → throws a `ConfigError`.
- **No port detected yet** (and no `port` override) → returns `null`.
- A `null` result is **dropped** from an env object — the variable is simply omitted
  rather than set to an empty string, so `API_URL: ctx.url("api")` is safe even before
  the port is up.

`ctx.url()` is available wherever a `ServiceContext` is — dynamic `env`, command
functions, the `url:` field, and task `run` callbacks (also as `ctx.services.url()`).

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

| Option        | Type                                             | Default | Description                                                                 |
| ------------- | ------------------------------------------------ | ------- | --------------------------------------------------------------------------- |
| `name`        | `string`                                         | —       | Display name in the TUI                                                     |
| `description` | `string`                                         | —       | Description shown in the task picker                                        |
| `commands`    | `string \| string[]`                             | —       | Shell command(s) to run                                                     |
| `run`         | `(ctx: TaskRunContext) => void \| Promise<void>` | —       | Programmatic task function (mutually exclusive with `commands`)             |
| `cwd`         | `string`                                         | —       | Working directory                                                           |
| `env`         | `Record<string, string>`                         | —       | Environment variables                                                       |
| `dependsOn`   | `string[]`                                       | `[]`    | Tasks that must run first                                                   |
| `shortcut`    | `string`                                         | —       | Hint key shown beside the task in the picker                                |
| `popup`       | `boolean \| { width?: string; height?: string }` | —       | Configured hook popup preference (commands only)                            |
| `sentra`      | `boolean \| { env: Record<string, string> }`     | —       | Send Sentry SDK errors to ZAPS (see [Sentry Errors](#sentry-errors-sentra)) |

Background tasks resolve dependencies before the selected task. `zaps run` and
in-app background runs execute every dependency in background mode, regardless of
its `popup` setting. Accepted runs retain their captured config/environment and
output through UI disconnect or service-manager reload. Session destruction stops
owned child processes; arbitrary JavaScript callbacks must cooperate with
cancellation.

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
  url(service: string, opts?: UrlOptions): string | null;  // mirrors services.url()
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

Define a custom tmux pane layout. The `@tui` pane is required because it hosts the
ZAPS dashboard. Shell ignores valid layout and lazy-pane presentation preferences,
while normal configuration validation and autostart flags still apply.

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
- Services not in the layout get their own vertical split pane in the `@tui` window
- Detached services must **not** appear in the layout

If no layout is specified, `@tui` gets the main pane and each non-detached service gets a vertical split pane in the same window.

## TUI

The TUI provides a dashboard, command palette, task picker, help, logs and failure
output for either backend. Available actions follow backend capabilities and live
service targets. Shell keeps service controls, URLs, background tasks and in-app
overlays; focus, zoom, pane capture/edit, task panes, popups and raw input are
unavailable. Unsupported keys do nothing, and unavailable actions/hints are hidden.
Combined Docker-group rebuild actions are also unavailable.

### Global keys

Work from any base view; survive a disconnect; yield to an open overlay.

| Key          | Action                                                             |
| ------------ | ------------------------------------------------------------------ |
| `Ctrl-K` `:` | Open the command palette (fuzzy actions)                           |
| `?`          | Toggle the help overlay                                            |
| `t`          | Open the task picker                                               |
| `f`          | Open the captured output of the latest failure                     |
| `x`          | Acknowledge — clear sticky failure toasts                          |
| `q` `Ctrl-C` | Detach (services keep running)                                     |
| `Ctrl-D`     | Shut down the session (stop services + destroy) — confirm with `y` |
| `Esc`        | Close the top overlay / leave the current view                     |

### Dashboard

| Key           | Action                                   |
| ------------- | ---------------------------------------- |
| `Up/Down/j/k` | Navigate services                        |
| `r`           | Restart selected service                 |
| `s`           | Start/stop selected service              |
| `l`           | View logs for selected service           |
| `o`           | Open service URL in browser              |
| `R`           | Docker rebuild (docker services)         |
| `z` / `Z`     | Zoom the service pane / the TUI pane     |
| `E`           | Edit-capture the selected pane           |
| `a`           | Restart all services                     |
| `c`           | Reload config (when changed + idle)      |
| `t`           | Open the task picker                     |
| `d`           | Shut down the session (confirm with `y`) |

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

Fuzzy picker over the project's tasks. Pane mode requires a live terminal capability:

| Key       | Action                                                                |
| --------- | --------------------------------------------------------------------- |
| type      | Fuzzy-filter tasks                                                    |
| `Up/Down` | Move selection                                                        |
| `Enter`   | Run in the default mode (`ui.task.defaultMode`, default `background`) |
| `Tab`     | Run in a pane when supported; disabled in shell                       |
| `Esc`     | Close                                                                 |

- **Background** runs stream into the daemon's retained output buffer; success
  shows a transient toast, failure a sticky one.
- **Run-in-pane** opens a pane/window for the selected task's shell commands only;
  it does not traverse dependencies or run a programmatic `run` callback. The pane
  stays open on completion so its output remains inspectable.

In shell, a configured pane default falls back to background for `Enter`, and
`Tab` is disabled. Explicit unsupported pane requests fail rather than changing
mode. `ui.task.popupPicker: true` uses an `fzf` popup only with supported popups and
a usable client; otherwise it falls back to the in-app picker. A busy terminal
operation or lost daemon connection is reported rather than opening another
fallback.

A task's `popup` option applies to configured hook execution, including dependency
nodes. It uses an owned tmux client when available; shell or no usable client
before launch falls back to background with a notice. If a started hook popup
loses its client, that run fails once without rerunning in background.

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
`display-popup` when supported and a client is available. With `ui.failOutput:
popup`, ZAPS attempts that presentation on open; shell retains the in-app overlay.

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

| Option             | Type                                       | Default        | Description                                                                                                 |
| ------------------ | ------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `icons`            | `"nerd" \| "unicode" \| "ascii"`           | `"nerd"`       | Glyph tier. `ZAPS_ICONS` env overrides the config value.                                                    |
| `notifications`    | `"off" \| "bell" \| "osc9" \| "osc9+bell"` | `"osc9"`       | Out-of-band failure notification channel (OSC 9 desktop notification and/or terminal bell).                 |
| `failOutput`       | `"overlay" \| "popup"`                     | `"overlay"`    | Where the `f` failed-output view opens; `popup` escalates straight to a tmux popup.                         |
| `wideThreshold`    | `number` (int ≥ 40)                        | `100`          | Minimum terminal columns to show the detail pane; below it the pane collapses.                              |
| `task.defaultMode` | `"background" \| "pane"`                   | `"background"` | Mode for `Enter` in the task picker (`Tab` needs pane support; shell falls back to background for `Enter`). |
| `task.popupPicker` | `boolean`                                  | `false`        | Use an `fzf` tmux popup picker instead of the in-app one (falls back when unavailable).                     |

## Service States

Valid transitions (the manager rejects any other move):

```
stopped     → starting
starting    → ready | error | stopping
ready       → stopping | restarting | error
stopping    → stopped
restarting  → starting | stopping | error
error       → starting           (retry / manual start)
unavailable → —                  (terminal: optional service whose binary/check failed)
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

## Sentry Errors (Sentra)

ZAPS can collect runtime errors from apps that use a Sentry SDK. The daemon runs a
small local receiver (Sentra) and hands each
opted-in service or task its own DSN. You then read the errors with `zaps sentra`,
`zaps ps`, `zaps prime-agent` or the MCP tools. Nothing leaves your machine.

### Setup

Add a top-level `sentra` block with an env template and opt services or tasks in:

```typescript
export function config({ define }: Library) {
  return define({
    sentra: {
      env: { SENTRY_DSN: "{dsn}", NUXT_PUBLIC_SENTRY_DSN: "{dsn}", SENTRY_ENABLED: "true" },
    },
    services: {
      web: { start: "pnpm dev", sentra: true },
      api: { start: "pnpm api", sentra: { env: { SENTRY_DSN: "{dsn}" } } },
      db: { docker: { service: "postgres" } },
    },
    tasks: {
      e2e: { name: "E2E", commands: "pnpm test:e2e", sentra: true },
    },
  });
}
```

| Option                        | Description                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `sentra.env`                  | Env template. `{dsn}` is replaced with the service's DSN. Values without it are passed as-is |
| `sentra.enabled`              | Default `true`. `false` turns Sentra off for every service and task                          |
| `sentra: true` (service/task) | Use the project template. Needs the top-level block                                          |
| `sentra: { env }`             | Own template that replaces the project one. Works without a top-level block                  |

- At least one `env` value must contain `{dsn}`, and keys must be valid env names.
  Otherwise the config fails to load with `sentra.env must use {dsn} in at least one value`
  or `sentra.env key '<key>' must match ^[A-Za-z_][A-Za-z0-9_]*$`.
- `sentra: true` without a top-level block fails with
  `services.<name>.sentra requires a top-level "sentra" block` (same for tasks).
- Names become the DSN's `<service>` segment (characters outside `[A-Za-z0-9._-]` turn
  into `-`). Two opted-in services or tasks that end up with the same segment, like
  `web app` and `web-app`, fail with `... both map to Sentra service "web-app"`.
  `--service` filters accept either spelling.
- The DSN looks like `http://sentra@127.0.0.1:<port>/<project>/<session>/<service>/1`.
  The port is picked once and reused across daemon restarts when it is free.
- Env precedence (low to high): the env of the calling shell, the Sentra env, the
  service or task `env`. Your own `env` always wins.
- Tasks get the same env, whether they run in the daemon, in a popup or in a pane.
- Docker services get the env too, but only the `docker compose` process sees it.
  `127.0.0.1` inside a container is the container itself, so this only works with
  `network_mode: host` or a compose file that passes the value on. ZAPS logs a
  warning once per service. Combined docker services that don't own the compose pane
  get no env, so they stay out of Sentra.
- The receiver starts with the first opted-in service or the first `zaps sentra`
  call. If it can't start, services still start without the Sentra env and the
  reason is logged.

### Nuxt

`@sentry/nuxt` needs `enabled` set, and the browser needs the DSN through public
runtime config. Use the template from the example above (`NUXT_PUBLIC_SENTRY_DSN`
fills `runtimeConfig.public.sentry.dsn`):

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@sentry/nuxt/module"],
  runtimeConfig: {
    public: { sentry: { dsn: "" } },
  },
});
```

```typescript
// sentry.client.config.ts
import * as Sentry from "@sentry/nuxt";

const dsn = useRuntimeConfig().public.sentry.dsn;
Sentry.init({ dsn, enabled: Boolean(dsn), tracesSampleRate: 0 });
```

```typescript
// sentry.server.config.ts
import * as Sentry from "@sentry/nuxt";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: process.env.SENTRY_ENABLED === "true",
  tracesSampleRate: 0,
});
```

The DSN uses `127.0.0.1`, not `localhost`: browsers may resolve `localhost` to `::1`,
and the receiver listens on IPv4 loopback only. Keep `tracesSampleRate: 0` in dev
unless you need traces; spans fill the database fast.

### Reading errors

```bash
T0=$(date -Iseconds)                 # remember the time before you test
# ... reproduce the bug or run tests ...
zaps sentra errors --from "$T0"      # what failed since then
zaps sentra show <id>                # stack trace and details as Markdown
zaps sentra issues --since 1h        # grouped by fingerprint
zaps sentra live --service web       # stream new errors
```

- `errors` defaults to `--kind error,message --min-level error`. Passing `--kind`,
  `--level` or `--min-level` drops the level default. `live` defaults to
  `--kind error,message --min-level warning` the same way.
- Time flags take ISO 8601, epoch ms, or a duration meaning "now minus" (`10m`).
  `--since` is a duration only and can't be combined with `--from`.
- `--q <text>` (also `-q`, `--query`) matches the title, case-insensitive.
- Paging: `--limit` (default 20, max 500) and `--skip`. When more rows exist, the
  text output ends with a ready-to-run `next:` command.
- `--fail-if-any` makes `errors` exit `1` when anything matches, handy in scripts.
- `location` is the crashing frame. With source maps it points at your source;
  without them it is an absolute path with line and column (`/abs/app.mjs:4:32`).
- Text output is TOON; `--json` prints JSON (`live --json` prints one row per line).
- Values that start with `-` need the `=` form: `--q=-foo`.
- Exit codes: unknown flags `1`, invalid values `2`, Sentra disabled or unavailable `1`.
- `receivedAt` is UTC. `live` prints the local time.

The query commands (`errors`, `issues`, `show`, `clear`) work without a running
session and start the daemon if needed, so you can still read errors after
`zaps down`. `live` needs a running session and never starts the daemon. When the
daemon goes away it prints `sentra: waiting for daemon…` once and reconnects every 2 s.

`zaps ps` shows an `ERRORS` column (errors since the service last started, `-` when
not opted in) only when Sentra is enabled. `zaps prime-agent` always adds a `sentra`
block (`status: disabled` when off) and lists the `zaps sentra` commands only when
Sentra is enabled.

To stream errors in a pane, add a service:

```typescript
"sentra-live": { start: "zaps sentra live --service web" },
```

### Data and retention

Records live in `$XDG_STATE_HOME/zaps/sentra.db` (fallback
`~/.local/state/zaps/sentra.db`), shared by all projects and filtered by session.
Events can hold request headers and bodies, so the directory is owner-only (0700).
The chosen port is kept in `sentra.json` next to it. Sentra deletes a session's data
after 30 days without new records, and spans, transactions, logs and other
non-error records after 7 days. `zaps sentra clear` deletes the current session's records right away. Events
sent while no daemon runs are lost.

## AI Integration

ZAPS offers two integration paths for AI coding agents: **Claude Code Skills** (recommended) and **MCP**. Skills are more token-efficient since they load context on-demand, while MCP provides a protocol-level interface usable by any MCP-compatible client.

### Agent Priming

Use `zaps prime-agent` to get one short agent instruction followed by a fenced TOON overview of the active project (name, session ID, folder, config), every service (state, ports, URL, Sentra error count), every task, the Sentra status (`disabled` when not enabled), and the commands agents may run. With Sentra enabled, the `zaps sentra errors|issues|show` commands and a hint to check errors after testing are added. The instruction tells agents to always run ZAPS commands outside the sandbox. Session and daemon lifecycle commands are intentionally omitted.

If daemon socket access is denied in a sandbox, the command tells the agent to rerun outside the sandbox. A stopped daemon is reported separately as `Daemon not running.`

### Claude Code Skills

ZAPS ships two [Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills) in `.claude/skills/`:

| Skill         | Description                                                                                |
| ------------- | ------------------------------------------------------------------------------------------ |
| `zaps-usage`  | Interact with dev sessions — start/stop services, run tasks, view logs, read Sentry errors |
| `zaps-config` | Author and edit ZAPS config files (`.zaps.mts`, `.zaps.ts`, `local.zaps.ts`)               |

Skills are **recommended over MCP** because they load reference docs on-demand rather than occupying persistent context, resulting in significantly lower token usage.

#### Installation

Copy the `.claude/skills/` directory into your project:

```bash
cp -r node_modules/@bosdev/zaps/.claude/skills/ .claude/skills/
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
| `sentra_errors`        | List Sentra error events (TOON)      |
| `sentra_issues`        | List grouped Sentra issues (TOON)    |
| `sentra_show`          | Show a record or issue (Markdown)    |

The `sentra_*` tools take the same filters as `zaps sentra errors|issues|show`. List
tools end with `hasMore: true|false`. Like the CLI query commands, they start the
daemon when it is not running, so errors of a stopped session stay readable. The other
MCP tools need a running session.

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

## Troubleshooting

### `zaps daemon stop` tears down services

`zaps daemon stop` cleans owned services, tasks and session resources before
shutting down. This applies to both backends. Managed tmux sessions are removed;
your personal tmux host is preserved while its ZAPS services stop. Cleanup errors
are reported instead of being described as a successful shutdown.

### A session ZAPS started is stuck

`zaps down` stops the selected session and removes any ZAPS-managed tmux host.
After daemon failure, there is no live-process adoption or restored log history.
Stale managed tmux hosts are checked conservatively; uncertain ownership requires
inspection rather than assuming cleanup succeeded. Shell sessions have no tmux
host to inspect. For a managed tmux host, target its exact session name:

```bash
tmux -L zaps ls                 # list the sessions ZAPS created
tmux -L zaps kill-session -t =zaps-my-app-a1b2c3d4e5f6
```

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

## License

MIT
