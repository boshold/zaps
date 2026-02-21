# Hooks — Project & Service Lifecycle

## Project-Level Hooks

Defined on `ProjectConfig.hooks`:

| Hook | Signature | When |
|---|---|---|
| `onStart` | `() => void \| Promise<void>` | All autostart services are ready |
| `onStop` | `() => void \| Promise<void>` | All services have stopped |
| `onServiceStart` | `(name: string) => void \| Promise<void>` | A service reaches ready state |
| `onServiceStop` | `(name: string) => void \| Promise<void>` | A service stops |

```ts
hooks: {
  onStart: () => console.log("All services ready"),
  onStop: () => console.log("Shutting down"),
  onServiceStart: (name) => console.log(`${name} started`),
  onServiceStop: (name) => console.log(`${name} stopped`),
}
```

## Per-Service Hooks

Defined directly on `ServiceConfig`:

| Hook | Signature | When |
|---|---|---|
| `onReady` | `() => void \| Promise<void>` | Service reaches ready state |
| `onStop` | `() => void \| Promise<void>` | Service stops |
| `onOutput` | `(line: string) => void \| Promise<void>` | New output line detected in tmux pane |

```ts
services: {
  api: {
    start: "node server.js",
    ready: { port: 3000 },
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

1. Service becomes ready
2. Project `hooks.onServiceStart(name)` fires
3. Per-service `onReady()` fires
4. After **all** autostart services are ready -> project `hooks.onStart()` fires

**Shutdown** (services stop in reverse topological order):

1. Service stops
2. Project `hooks.onServiceStop(name)` fires
3. Per-service `onStop()` fires
4. After **all** services stopped -> project `hooks.onStop()` fires

## Library Actions in Hooks

The `Library` object destructured in `config()` provides runtime actions usable inside hooks:

| Method | Signature | Description |
|---|---|---|
| `runTask` | `(key: string) => Promise<void>` | Run a defined task by key |
| `startService` | `(name: string) => Promise<void>` | Start a service |
| `restartService` | `(name: string) => Promise<void>` | Restart a service |
| `stopService` | `(name: string) => Promise<void>` | Stop a service |
| `isServiceRunning` | `(name: string) => boolean` | Check if a service is running |
| `openInBrowser` | `(url: string) => Promise<void>` | Open URL in default browser |

```ts
export function config({ defineProject, runTask, startService, openInBrowser }: Library) {
  return defineProject({
    services: {
      db: {
        docker: { service: "postgres" },
        onReady: () => runTask("migrate"),
      },
      api: {
        start: "npm run dev:api",
        ready: { port: 3001 },
        dependsOn: ["db"],
      },
    },
    tasks: {
      migrate: { name: "Run migrations", commands: "prisma migrate deploy" },
    },
    hooks: {
      onStart: () => openInBrowser("http://localhost:3000"),
    },
  });
}
```

## onOutput Monitoring Details

- Monitors tmux pane output by polling every **1 second**
- Uses diff-based detection: compares previous capture to current (last 500 lines)
- Only fires for non-empty lines
- Errors thrown inside `onOutput` are swallowed — they don't crash the service

```ts
services: {
  api: {
    start: "npm run dev",
    onOutput: (line) => {
      if (line.includes("compiled successfully")) {
        console.log("Build complete");
      }
    },
  },
}
```

## Error Handling

- Hook errors are caught and logged as `lastError` on the service status
- Hook errors **do not** fail the service start/stop lifecycle
- The service continues operating normally even if a hook throws

## Cross-Service Orchestration Example

```ts
export function config({ defineProject, runTask, restartService, isServiceRunning, openInBrowser }: Library) {
  return defineProject({
    services: {
      db: {
        docker: { service: "postgres" },
        ready: { port: 5432 },
        onReady: () => runTask("migrate"),
      },
      api: {
        start: "npm run dev:api",
        ready: { port: 3001 },
        dependsOn: ["db"],
        onOutput: (line) => {
          if (line.includes("schema changed")) {
            void restartService("web");
          }
        },
      },
      web: {
        start: "npm run dev",
        ready: { port: 3000 },
        dependsOn: ["api"],
      },
    },
    tasks: {
      migrate: { name: "Run migrations", commands: "prisma migrate deploy" },
    },
    hooks: {
      onStart: () => openInBrowser("http://localhost:3000"),
      onServiceStart: (name) => console.log(`[zaps] ${name} started`),
      onServiceStop: (name) => console.log(`[zaps] ${name} stopped`),
    },
  });
}
```

## Gotchas

- **Library actions only work in hooks** — calling `runTask`, `startService`, etc. at config definition time throws `"not available outside of service hooks"`
- **Hook errors don't fail lifecycle** — errors are logged but the service continues starting/stopping normally
- **onOutput is not real-time** — it polls every 1s via tmux pane capture, not a direct stream
- **`openInBrowser` works anytime** — unlike other library actions, it doesn't require runtime context
