# Services — ServiceConfig

## Options

| Field       | Type                                      | Default     | Description                                   |
| ----------- | ----------------------------------------- | ----------- | --------------------------------------------- |
| `start`     | `string \| () => string`                  | —           | Long-running process command (server)         |
| `run`       | `string \| () => string`                  | —           | One-shot command                              |
| `stop`      | `string \| () => string`                  | —           | Custom stop command                           |
| `cwd`       | `string`                                  | —           | Working directory for the service             |
| `detached`  | `boolean`                                 | `false`     | Run outside tmux layout (hidden pane)         |
| `docker`    | `DockerConfig`                            | —           | Docker Compose config (see docker reference)  |
| `ready`     | `ReadyConfig`                             | —           | Ready detection (see ready reference)         |
| `dependsOn` | `string[]`                                | —           | Services that must be ready first             |
| `env`       | `EnvConfig`                               | —           | Environment variables                         |
| `flags`     | `ServiceFlags`                            | —           | `{ start?: boolean, open?: boolean }`         |
| `url`       | `string \| false \| (ctx) => string`      | auto-detect | URL for the service                           |
| `raw`       | `boolean`                                 | `false`     | Bypass wrapper — show env vars inline in pane |
| `restart`   | `{ maxRetries?, backoff? }`               | —           | Restart policy with exponential backoff       |
| `onReady`   | `() => void \| Promise<void>`             | —           | Hook: service reached ready state             |
| `onStop`    | `() => void \| Promise<void>`             | —           | Hook: service stopped                         |
| `onOutput`  | `(line: string) => void \| Promise<void>` | —           | Hook: new output line from tmux pane          |

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

`detached: true` runs the service in a hidden tmux pane — no visible pane in the layout.

- Still managed by ServiceManager (start/stop/ready detection all work)
- **Must NOT appear in layout** — validation error if a detached service is referenced in layout

```ts
services: {
  worker: {
    start: "node worker.js",
    detached: true,
    ready: { port: 4000 },
  },
}
```

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

// Dynamic
url: (ctx) => `http://localhost:${ctx.port}/admin`;
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
