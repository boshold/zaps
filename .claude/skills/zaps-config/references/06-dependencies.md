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

`flags: { start: false }` excludes a service from **autostart** but does **not** remove it from the dependency graph. Two paths behave differently:

- **During `zaps up` (autostart):** a `dependsOn` pointing at a non-autostart service is **treated as satisfied** — the dependent **still autostarts**, and ZAPS prints a load-time warning that the dep won't be started for you. The non-autostart service stays stopped until you start it.
- **Explicit start** (`zaps start <dependent>` / `service.start()`): the real dependency state is enforced — the dependent waits for its deps to be `ready` and fails if they aren't.

```ts
services: {
  db: { start: "...", ready: { port: 5432 }, flags: { start: false } },
  api: { start: "...", dependsOn: ["db"] },
}
// `zaps up`: api autostarts; db is treated as satisfied (with a warning) and stays stopped.
//   Warning: service 'api' depends on non-autostart service 'db'; 'db' is treated as
//   satisfied during 'zaps up' (start it explicitly with 'zaps start db').
// `zaps start api` later: enforces deps — db must be ready first.
```

## restartWith — Cascade Restart

`restartWith` ties a service to the restart of one of its **dependencies**: when a service you list here restarts (manually or after a crash), **this** service restarts too. It's the "follow the upstream" rule — e.g. restart `api` whenever `db` is recreated so it reconnects. Every `restartWith` entry **must also appear in `dependsOn`** (it is validated as a subset) — you can only follow something you already depend on.

```ts
services: {
  db: { start: "...", ready: { port: 5432 } },
  api: {
    start: "...",
    dependsOn: ["db"],
    restartWith: ["db"], // when db restarts, api restarts too; "db" must be in dependsOn
  },
}
```

- The cascade is transitive — if `api` has `restartWith: ["db"]` and `web` has `restartWith: ["api"]`, restarting `db` cascades `db → api → web`.
- A group name (from a docker `expand`) in `restartWith` expands to all of its children.

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
- `flags: { start: false }` only affects autostart — the service stays in the graph. On `zaps up`, dependents treat it as satisfied and start anyway (with a warning); an explicit `zaps start <dependent>` enforces the real dependency state
- A dependency must be in `"ready"` state, not just `"starting"` — configure `ready` detection on deps
- Shutdown uses `reverseTopoSort` on **all** services (not just autostart-filtered ones)
