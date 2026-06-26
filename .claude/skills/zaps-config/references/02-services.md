# Services — ServiceConfig

## Options

| Field       | Type                                      | Default     | Description                                                                                |
| ----------- | ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `start`     | `string \| () => string`                  | —           | Long-running process command (server)                                                      |
| `run`       | `string \| () => string`                  | —           | One-shot command                                                                           |
| `stop`      | `string \| () => string`                  | —           | Custom stop command                                                                        |
| `cwd`       | `string`                                  | —           | Working directory for the service                                                          |
| `detached`  | `boolean`                                 | `false`     | Run pane-less (outside the tmux layout)                                                    |
| `lazyPane`  | `boolean`                                 | _auto_      | Pane created on start, dropped on explicit stop (default `true` when `flags.start: false`) |
| `docker`    | `DockerConfig`                            | —           | Docker Compose config (see docker reference)                                               |
| `ready`     | `ReadyConfig`                             | —           | Ready detection (see ready reference)                                                      |
| `dependsOn` | `string[]`                                | —           | Services that must be ready first                                                          |
| `restartWith` | `string[]`                              | —           | Restart this service when a listed dependency restarts (must be a subset of `dependsOn`)    |
| `env`       | `EnvConfig`                               | —           | Environment variables                                                                      |
| `flags`     | `ServiceFlags`                            | —           | `{ start?: boolean, open?: boolean }`                                                      |
| `url`       | `string \| false \| (ctx) => string`      | auto-detect | URL for the service                                                                        |
| `raw`       | `boolean`                                 | `false`     | Bypass wrapper — show env vars inline in pane                                              |
| `restart`   | `{ maxRetries?, backoff? }`               | —           | Restart policy with exponential backoff                                                    |
| `onBeforeStart` | `() => void \| Promise<void>`         | —           | Hook: before the service command is sent                                                   |
| `onReady`   | `() => void \| Promise<void>`             | —           | Hook: service reached ready state                                                          |
| `onStop`    | `() => void \| Promise<void>`             | —           | Hook: service stopped                                                                      |
| `onOutput`  | `(line: string) => void \| Promise<void>` | —           | Hook: new output line from tmux pane                                                       |
| `optional`  | `boolean \| (ctx) => boolean \| Promise<boolean>` | —   | Mark service as optional (skip if unavailable); the function form gets `ctx.hasBinary(name)` |

**Required**: Every service must have at least one of `start`, `run`, or `docker`.

## Command Resolution

Priority order:

1. If `docker` is set and no `start`/`run` — auto-generates `docker compose up` command
2. `start` takes precedence over `run` (`start ?? run`)
3. If `Command` is a function, it is called at resolve time to produce the string

```ts
// String command
start: "npm run dev";

// Function command (resolved at start time)
start: () => `node server.js --port=${getPort()}`;
```

### start vs run

- `start` — long-running process (e.g. dev server). Stays alive, monitored for crashes.
- `run` — one-shot command. Executes and exits.

## Detached Services

`detached: true` runs the service **pane-less** — it has no tmux pane at all, not just a hidden one.

- Still managed by ServiceManager (start/stop/ready detection and crash recovery all work)
- **Must NOT appear in layout** — config load error if a detached service is referenced in layout
- **Cannot combine with `docker` or `raw`** — both require a pane; either combination is a config load error
- Requires a `start` or `run` command (there is no pane to interact with otherwise)
- No live terminal — read its output via the log buffer (`zaps logs <name>`, `-f` to stream)

```ts
services: {
  worker: {
    start: "node worker.js",
    detached: true,
    ready: { port: 4000 },
  },
}
```

## Lazy Panes

A lazy service's tmux pane only exists while the process is running:

- Pane **created on start** at the exact declared layout position (insert);
  pane **destroyed on explicit stop** (remove); survivors re-expand.
- **Crash keeps the pane** (post-mortem output stays visible).
- **Restart keeps the pane** (process replaced in place; restarting a
  stopped pane-less lazy service re-creates the pane at the declared slot).
- Service `logs` history is retained across the lazy stop, so
  `zaps logs <name>` still returns prior output after the pane is gone.

**Default rule:** `lazyPane` defaults to `true` for non-autostart services
(`flags.start: false`) and `false` for autostart services. An explicit value
always wins.

**Group members and detached services are never lazy.** A docker-group
member (a child expanded from `docker.service: [...]` with `expand`) and a
`detached: true` service both resolve to `lazyPane: false` even when
`flags.start: false` is set — the group's shared pane / pane-less detached
behavior is unchanged. The boot-skip predicate only fires for own-pane
services.

```ts
services: {
  // Non-autostart → defaults to lazyPane:true (pane appears on first start)
  mailpit: {
    start: "mailpit",
    flags: { start: false },
    ready: { port: 8025 },
  },

  // Explicit opt-in lazy on an autostart service: boots paned, but a manual
  // stop drops the pane (vs the non-lazy default of keeping it).
  worker: {
    start: "node worker.js",
    lazyPane: true,
  },

  // Explicit opt-out: keep the legacy empty-reserved-pane-at-boot behavior.
  legacyConsole: {
    start: "tail -f /var/log/app.log",
    flags: { start: false },
    lazyPane: false,
  },
}
```

**Illegal combinations** (config load errors):

- `lazyPane: true` + `detached: true` — a detached service has no pane.
  Schema-level rejection.
- `lazyPane: true` on a docker-group member (a child of `docker.service: [...]`
  with `expand`) — group members share one pane, so per-member lazy is
  ambiguous. Loader-level rejection after expansion.

## Flags

```ts
flags: {
  start: false,  // Skip autostart — manual start only (via TUI)
  open: true,    // Auto-open URL in browser when service becomes ready
}
```

## URL Resolution

| Value             | Behavior                           |
| ----------------- | ---------------------------------- |
| _(omitted)_       | Auto-detected from listening ports |
| `string`          | Explicit URL                       |
| `false`           | Disable URL detection entirely     |
| `(ctx) => string` | Dynamic URL from `ServiceContext`  |

```ts
// Explicit
url: "http://localhost:3000";

// Disabled
url: false;

// Dynamic — read the port from the service's own entry on the context
// (there is no top-level `ctx.port`; use `ctx.services.<name>` or `ctx.url()`)
url: (ctx) => `http://localhost:${ctx.services.admin.port}/admin`;
```

## Restart Policy

Crashed services restart with exponential backoff.

| Option       | Default | Description                               |
| ------------ | ------- | ----------------------------------------- |
| `maxRetries` | `3`     | Maximum restart attempts                  |
| `backoff`    | `1000`  | Initial backoff in ms, doubles each retry |

Backoff sequence (default): 1s, 2s, 4s, then gives up.

```ts
restart: { maxRetries: 5, backoff: 500 }
// Backoff: 500ms, 1s, 2s, 4s, 8s
```

## Per-Service Hooks

```ts
services: {
  api: {
    start: "node server.js",
    ready: { port: 3000 },

    onReady: () => {
      console.log("API is up");
    },

    onStop: async () => {
      await cleanup();
    },

    onOutput: (line) => {
      if (line.includes("ERROR")) notifySlack(line);
    },
  },
}
```

- `onReady` — fires once when service reaches ready state
- `onStop` — fires when service is stopped
- `onOutput` — fires for each new output line (monitors the tmux pane)

## Optional Services

Mark services as optional when the binary may not exist on all machines. ZAPS checks availability at config load — unavailable services are stripped from layout and deps, shown greyed out in TUI.

**Boolean** — auto-checks the binary via `command -v`. The binary is the first **non-assignment** token of `start`/`run`, so leading `FOO=bar` env-prefixes are skipped (`DEBUG=1 rainfrog …` probes `rainfrog`). A command with no real binary token (only assignments, or blank) is treated as unavailable:

```ts
services: {
  rainfrog: {
    optional: true,
    start: "rainfrog -u postgres://localhost:5432",
    ready: { port: 5432 },
  },
}
```

**Function** — custom async predicate:

```ts
services: {
  "custom-tool": {
    optional: async () => {
      const { execSync } = await import("node:child_process");
      try { execSync("docker image inspect my-tool"); return true; }
      catch { return false; }
    },
    docker: { service: "my-tool" },
  },
}
```

**Rules:**

- `optional: true` requires `start` or `run` as a **string** (not function) — ZAPS extracts the binary name from it (skipping `FOO=bar` env-prefix assignments)
- Docker-only services must use the function form
- Unavailable services: no pane, `dependsOn`/`restartWith` refs silently dropped, layout auto-collapses
- Predicate timeout: 5 seconds

## Full Example

```ts
services: {
  web: {
    start: "npm run dev",
    cwd: "./packages/web",
    ready: { port: 3000 },
    url: "http://localhost:3000",
    flags: { open: true },
    restart: { maxRetries: 3, backoff: 1000 },
    onReady: () => console.log("Web ready"),
  },

  api: {
    start: "cargo watch -x run",
    ready: { port: 8080 },
    dependsOn: ["db"],
    env: { RUST_LOG: "debug" },
  },

  docs: {
    start: "npm run docs:dev",
    ready: { port: 5173 },
    flags: { start: false, open: true },
  },

  worker: {
    run: "node scripts/seed.js",
    detached: true,
  },
}
```
