# Hooks — Project & Service Lifecycle

## Project-Level Hooks

Defined on `ProjectConfig.hooks`:

| Hook            | Signature                     | When                             |
| --------------- | ----------------------------- | -------------------------------- |
| `onBeforeStart` | `() => void \| Promise<void>` | Before any service starts        |
| `onStart`       | `() => void \| Promise<void>` | All autostart services are ready |
| `onStop`        | `() => void \| Promise<void>` | All services have stopped        |

```ts
hooks: {
  onBeforeStart: () => console.log("Setting up"),
  onStart: () => console.log("All services ready"),
  onStop: () => console.log("Shutting down"),
}
```

## Per-Service Hooks

Defined directly on `ServiceConfig`:

| Hook            | Signature                                 | When                                  |
| --------------- | ----------------------------------------- | ------------------------------------- |
| `onBeforeStart` | `() => void \| Promise<void>`             | Before service command is sent        |
| `onReady`       | `() => void \| Promise<void>`             | Service reaches ready state           |
| `onStop`        | `() => void \| Promise<void>`             | Service stops                         |
| `onOutput`      | `(line: string) => void \| Promise<void>` | New output line detected in tmux pane |

```ts
services: {
  api: {
    start: "node server.js",
    ready: { port: 3000 },
    onBeforeStart: () => console.log("Preparing API"),
    onReady: () => console.log("API ready"),
    onStop: () => console.log("API stopped"),
    onOutput: (line) => {
      if (line.includes("ERROR")) console.error("API error:", line);
    },
  },
}
```

## Execution Order

**Startup** (services start in topological order by dependency levels):

1. Global `hooks.onBeforeStart()` fires (once)
2. Per-service `onBeforeStart()` fires
3. Service command is sent to pane
4. Service becomes ready
5. Per-service `onReady()` fires
6. After **all** autostart services are ready -> global `hooks.onStart()` fires

**Shutdown** (services stop in reverse topological order):

1. Service stops
2. Per-service `onStop()` fires
3. After **all** services stopped -> global `hooks.onStop()` fires

## Library Actions in Hooks

The `Library` object destructured in `config()` provides runtime actions usable inside hooks:

| Namespace | Member            | Description                       |
| --------- | ----------------- | --------------------------------- |
| `task`    | `run(key)`        | Run a defined task by key         |
| `service` | `start(name)`     | Start a service                   |
| `service` | `restart(name)`   | Restart a service                 |
| `service` | `stop(name)`      | Stop a service                    |
| `service` | `isRunning(name)` | Check if a service is running     |
| `browser` | `open(url)`       | Open a URL in the default browser |

```ts
export function config({ define, task }: Library) {
  return define({
    services: {
      db: {
        docker: { service: "postgres" },
        onReady: () => task.run("migrate"),
      },
      api: {
        start: "pnpm dev:api",
        ready: { port: 3001 },
        dependsOn: ["db"],
      },
    },
    tasks: {
      migrate: { name: "Run migrations", commands: "prisma migrate deploy" },
    },
  });
}
```

Keep browser opening opt-in. An explicit service `url` is enough to show the address in the TUI. Use `flags.open: true` or `browser.open()` only when requested.

## onOutput Monitoring Details

- Monitors tmux pane output by polling every **1 second**
- Uses diff-based detection: compares previous capture to current (last 500 lines)
- Only fires for non-empty lines
- Errors thrown inside `onOutput` are swallowed — they don't crash the service

```ts
services: {
  api: {
    start: "pnpm dev",
    onOutput: (line) => {
      if (line.includes("compiled successfully")) {
        console.log("Build complete");
      }
    },
  },
}
```

## Error Handling

- Project hook errors propagate. An `onBeforeStart` failure aborts project startup.
- Per-service hook errors are caught and logged as `lastError` on the service status.
- Per-service hook errors do not fail the service start or stop lifecycle.

## Optional Mail Service Restart Pattern

```ts
export function config({ define, service }: Library) {
  let mailEnabled = false;

  async function restartAppForMail(enabled: boolean) {
    mailEnabled = enabled;
    if (service.isRunning("app")) {
      await service.restart("app");
    }
  }

  return define({
    services: {
      app: {
        start: "pnpm dev",
        ready: { port: 3000 },
        env: () => ({
          SMTP_ENABLED: mailEnabled ? "true" : "false",
        }),
      },
      mail: {
        optional: (ctx) => ctx.hasBinary("docker"),
        flags: { start: false },
        docker: { service: "mailpit" },
        ready: { http: "http://localhost:8025/" },
        url: "http://localhost:8025",
        onReady: () => restartAppForMail(true),
        onStop: () => restartAppForMail(false),
      },
    },
  });
}
```

Use hooks for a manually started service that changes another running service's environment. Use `restartWith` for dependency restarts instead.

## Gotchas

- **`task.*` and `service.*` only work in hooks** — calling them at config definition time throws `"not available outside of service hooks"`
- **Project hook errors propagate** — use project `onBeforeStart` for required setup that must abort startup
- **Per-service hook errors don't fail lifecycle** — errors are logged but the service continues starting or stopping
- **onOutput is not real-time** — it polls every 1s via tmux pane capture, not a direct stream
- **`browser.open` works anytime** — unlike `task.*`/`service.*`, it doesn't require runtime context; keep it opt-in
