# Docker Integration

ZAPS integrates with `docker compose` via the `docker` property on services.

## DockerConfig Options

| Option          | Type                               | Default      | Description                                   |
| --------------- | ---------------------------------- | ------------ | --------------------------------------------- |
| `service`       | `string \| string[]`               | **required** | Docker Compose service name(s)                |
| `file`          | `string`                           | `undefined`  | Custom compose file (`-f`)                    |
| `build`         | `boolean`                          | `false`      | Build images before starting (`--build`)      |
| `forceRecreate` | `boolean`                          | `false`      | Recreate containers (`--force-recreate`)      |
| `renewVolumes`  | `boolean`                          | `false`      | Recreate anonymous volumes (`-V`)             |
| `removeOrphans` | `boolean`                          | `false`      | Remove orphan containers (`--remove-orphans`) |
| `pull`          | `"always" \| "missing" \| "never"` | `undefined`  | Image pull policy (`--pull`)                  |
| `noDeps`        | `boolean`                          | `false`      | Skip dependency services (`--no-deps`)        |
| `expand`        | `boolean`                          | `false`      | Expand array services into individual entries |

## Command Generation

When `docker` is set, ZAPS builds a `docker compose up` command from the config flags:

```
docker compose [-f <file>] up [--build] [--force-recreate] [-V] [--remove-orphans] [--pull <policy>] [--no-deps] <service...>
```

Flags are appended only when their corresponding option is truthy/set.

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

Use `expand: true` with `service: string[]` to create individually addressable services sharing one pane:

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
      postgres: { onReady: () => runTask("prisma:deploy") },
      bugsink: { ready: { http: "http://localhost:8000/health" } },
    },
  },
}
```

Children without overrides inherit parent config. Overrides can set `ready`, `env`, hooks, `url`, `flags`, `restart`, etc.

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
