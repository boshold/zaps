# Docker Integration

ZAPS integrates with `docker compose` via the `docker` property on services.

## DockerConfig Options

| Option          | Type                                | Default      | Description                                                              |
| --------------- | ----------------------------------- | ------------ | ------------------------------------------------------------------------ |
| `service`       | `string \| string[]`                | **required** | Docker Compose service name(s)                                           |
| `file`          | `string`                            | `undefined`  | Custom compose file (`-f`)                                               |
| `projectName`   | `string`                            | `undefined`  | Pin the compose project name (`-p`)                                      |
| `build`         | `boolean`                           | `false`      | Build images before starting (`--build`)                                 |
| `forceRecreate` | `boolean`                           | `false`      | Recreate containers (`--force-recreate`)                                 |
| `renewVolumes`  | `boolean`                           | `false`      | Recreate anonymous volumes (`-V`)                                        |
| `removeOrphans` | `boolean`                           | `false`      | Remove orphan containers (`--remove-orphans`)                            |
| `pull`          | `"always" \| "missing" \| "never"`  | `undefined`  | Image pull policy (`--pull`)                                             |
| `noDeps`        | `boolean`                           | `false`      | Skip dependency services (`--no-deps`)                                   |
| `expand`        | `boolean \| Record<string, object>` | `false`      | Expand services into individual entries (`true`, or per-child overrides) |

## Command Generation

When `docker` is set, ZAPS builds a `docker compose up` command from the config flags:

```
docker compose -p <project> [-f <file>] up [--build] [--force-recreate] [-V] [--remove-orphans] [--pull <policy>] [--no-deps] <service...>
```

Flags are appended only when their corresponding option is truthy/set. Compose **v2.21+** is the tested baseline.

## Project Pinning

Every compose invocation (`up`/`ps`/`start`/`stop`/`restart`/`config`) is pinned with `-p <project>` so two checkouts in same-named directories don't collide. The project name resolves by precedence:

1. `docker.projectName`
2. `ZAPS_COMPOSE_PROJECT` env (read in the daemon process)
3. the compose file's top-level `name:`
4. `zaps-<sanitized-dir>-<hash>` (default — deterministic per absolute cwd)

Switching to a pinned project recreates the containers once; if containers exist under the old unpinned name, ZAPS prints a one-time cleanup warning.

**Tasks don't inherit the pin.** The `-p` project is applied only to the compose commands ZAPS runs for `docker` **services**. A task that shells out to bare `docker compose …` (in `commands` or `run`) uses Compose's own default project, so it won't act on the containers ZAPS started. Pass it explicitly — `docker compose -p "$ZAPS_COMPOSE_PROJECT" …` (set `ZAPS_COMPOSE_PROJECT` where the daemon spawns) — or prefer a logical operation (e.g. `prisma migrate reset`) over `docker compose down -v` in tasks.

## Auto-Command

If a service has `docker` config but **no `start` or `run`**, ZAPS auto-generates the command from `buildDockerCommand()`. No manual command needed:

```ts
services: {
  db: {
    docker: { service: "postgres" },
    // No start/run needed — ZAPS generates: docker compose up postgres
  },
  infra: {
    docker: { service: ["postgres", "redis"] },
    // Generates: docker compose up postgres redis (single pane)
  },
}
```

When `service` is an array, all services run in one `docker compose up` command in a single pane.

If `start` or `run` is provided, that takes precedence and the docker command is not generated.

## Auto-Ready Detection

If a service has `docker` config but **no explicit `ready`**, ZAPS auto-uses docker container status polling:

```ts
// Internally resolved as:
ready: {
  docker: config.docker.service,  // string | string[]
  file: config.docker.file,
}
```

The `file` from `DockerConfig` is passed through to the status check automatically.

## Container Health Checking

Docker ready detection polls `docker compose ps --format json <service>` every 500ms (60s timeout).

When `service` is an array, each service is polled individually per tick — **all** must be ready for the check to pass.

A container is **ready** when both conditions are met:

- `State === "running"`
- `Health === ""` (no healthcheck defined) OR `Health === "healthy"`

Handles both JSON array and JSONL output formats from different Docker Compose versions.

For recreate-style starts (`build` / `forceRecreate` / `renewVolumes`), readiness additionally waits for the container id to change, so a leftover container left running from a previous session can't briefly report "ready" before `up` tears it down and recreates it. A container that stays `exited`/`dead` fails fast — the error carries the container state and the last pane output, instead of waiting out the full 60s timeout.

**`ready: { port }` and path-style `ready: { http: "/path" }` are not allowed on docker services** — they fail at config load. Published ports are held by `dockerd`, not the pane, so detection never matches. Use the default docker readiness or a full-URL `ready: { http: "http://127.0.0.1:<port>/path" }`.

## Port Extraction

Published host ports are extracted from the container's `Publishers` array in the `docker compose ps` JSON output. Ports are deduplicated and sorted ascending. When `service` is an array, ports from all containers are aggregated. These ports populate `status.ports` for the service.

## URL Behavior

Docker services have **URL auto-detection disabled by default**. No port probing occurs. To enable a URL for a docker service, set `url` explicitly:

```ts
services: {
  db: {
    docker: { service: "postgres" },
    url: "http://localhost:5432",
  },
}
```

## Examples

### Minimal

```ts
services: {
  db: {
    docker: { service: "postgres" },
  },
}
```

Auto-generates `docker compose up postgres`, auto-detects ready via container status.

### Multiple Services (Single Pane)

```ts
services: {
  infra: {
    docker: { service: ["postgres", "redis"] },
  },
}
```

Generates: `docker compose up postgres redis`. Both containers must be ready.

### With Build and Pull

```ts
services: {
  db: {
    docker: {
      service: "postgres",
      file: "docker-compose.dev.yml",
      build: true,
      forceRecreate: true,
      pull: "always",
    },
  },
}
```

Generates: `docker compose -f docker-compose.dev.yml up --build --force-recreate --pull always postgres`

### Docker with Custom Ready

Override auto-ready with any other ready strategy:

```ts
services: {
  db: {
    docker: { service: "postgres" },
    ready: { http: "http://localhost:5432" },
  },
}
```

### Expanded Docker Services

Use `expand: true` to create individually addressable services sharing one pane. It works with an array `service` (one child per name) or a single-string `service` (one child):

```ts
services: {
  infra: {
    docker: {
      service: ["postgres", "redis", "mailpit"],
      expand: true,
    },
  },
  api: {
    start: "pnpm dev",
    dependsOn: ["postgres"],  // reference expanded child
  },
}
```

Creates 3 individual services (`postgres`, `redis`, `mailpit`) that:

- Share a single pane (one `docker compose up` command)
- Have independent status, ready detection, lifecycle
- Can be started/stopped/restarted individually
- Can be referenced individually in `dependsOn`
- Appear grouped under "infra" in the TUI

Layout references use the group name: `{ pane: "infra" }`.

Use `expand: { ... }` for per-child overrides:

```ts
infra: {
  docker: {
    service: ["caddy", "postgres", "bugsink"],
    expand: {
      postgres: { onReady: () => task.run("prisma:deploy") },
      bugsink: { ready: { http: "http://localhost:8000/health" } },
    },
  },
}
```

Children without overrides inherit parent config. Overrides can set `ready`, `env`, hooks, `url`, `flags`, `restart`, etc.

**Override validation (G7):** an override **may not** set `start`, `run`, `docker`, or the internal `_combined` — the command and docker config are inherited from the group, and overriding them would break the shared pane. Unknown keys (e.g. a `redy:` typo) are also rejected. Any forbidden or unknown key fails config load with an error naming the group, the child, and the offending key:

```
Docker expand override for child 'postgres' in group 'infra' has invalid key(s): start
```

### Docker with Dependencies

```ts
services: {
  db: {
    docker: { service: "postgres" },
  },
  api: {
    start: "pnpm dev",
    dependsOn: ["db"],
    ready: { port: 3000 },
  },
}
```
