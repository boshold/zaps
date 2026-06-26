# Dependencies — dependsOn

## Syntax

Both services and tasks accept `dependsOn` — an array of keys referencing other services or tasks:

```ts
services: {
  db: { start: "docker compose up postgres", ready: { port: 5432 } },
  api: {
    start: "npm run dev:api",
    ready: { port: 3001 },
    dependsOn: ["db"],
  },
  frontend: {
    start: "npm run dev",
    ready: { port: 3000 },
    dependsOn: ["api"],
  },
}
```

## Topological Sort (Startup Order)

Kahn's algorithm groups services into **levels** — services within the same level have no mutual dependencies and start **in parallel**.

Given the example above:

| Level | Services   | Behavior                        |
| ----- | ---------- | ------------------------------- |
| 0     | `db`       | No deps, starts first           |
| 1     | `api`      | Waits for `db` to be **ready**  |
| 2     | `frontend` | Waits for `api` to be **ready** |

Services with independent dependency chains start in parallel:

```ts
services: {
  db: { start: "...", ready: { port: 5432 } },
  redis: { start: "...", ready: { port: 6379 } },
  api: { start: "...", dependsOn: ["db", "redis"] },
}
// Level 0: [db, redis]  — start in parallel
// Level 1: [api]        — waits for both to be ready
```

Each level awaits `Promise.all()` of its services before proceeding to the next level. A dependency must reach `"ready"` state before its dependent can start — otherwise `service.start()` throws.

## Shutdown Order

`reverseTopoSort()` reverses the levels. Dependents stop **before** their dependencies:

```
Startup:  db → api → frontend
Shutdown: frontend → api → db
```

Shutdown also uses `Promise.all()` per level for parallel stopping within a level.

## flags.start and the Dependency Graph

`flags: { start: false }` excludes a service from **autostart** but does **not** remove it from the dependency graph. If another service depends on it, that dependent will fail to start (dependency not ready).

```ts
services: {
  db: { start: "...", ready: { port: 5432 }, flags: { start: false } },
  api: { start: "...", dependsOn: ["db"] },
}
// api won't autostart because db is excluded from autostart and won't be ready
// Start db manually via TUI first, then api can start
```

## Validation

Performed at config load time in `validateSemantics()`:

1. **Unknown references** — each `dependsOn` entry must match an existing service/task key. Throws: `Service 'api' references unknown dependency 'db'`
2. **Circular dependencies** — DFS-based cycle detection. Throws with the full cycle path: `Circular dependency detected: a → b → c → a`

Service deps are validated against service keys. Task deps are validated against task keys. Cross-referencing (service depending on task or vice versa) is not supported.

## Task Dependencies

Tasks also support `dependsOn`, referencing other task keys:

```ts
tasks: {
  migrate: {
    name: "Run migrations",
    commands: "npx prisma migrate deploy",
  },
  seed: {
    name: "Seed database",
    commands: "npx prisma db seed",
    dependsOn: ["migrate"],
  },
}
```

Task dependency execution differs from services:

- Dependencies run **sequentially** (not in parallel levels)
- Uses recursive DFS with a visited set to avoid re-running completed deps
- If a dependency **fails**, the dependent is **skipped** (returns `false`)
- Already-succeeded deps are not re-executed

## Gotchas

- `dependsOn` entries must reference valid keys of the same type (services reference services, tasks reference tasks)
- Circular deps throw with the full cycle path for debugging
- `flags: { start: false }` only affects autostart — the service remains in the graph and must be manually started for dependents to proceed
- A dependency must be in `"ready"` state, not just `"starting"` — configure `ready` detection on deps
- Shutdown uses `reverseTopoSort` on **all** services (not just autostart-filtered ones)
