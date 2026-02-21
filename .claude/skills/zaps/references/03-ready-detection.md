# Ready Detection

All mechanisms use polling: **500ms interval**, **60s timeout** (fixed, not configurable). Checks are abortable via `AbortSignal`.

If no `ready` is set but `docker` config exists, ZAPS auto-creates `{ docker: config.docker.service }`.

## Mechanisms

### Port

```ts
ready: { port: number | true | (() => number) }
```

- `port: 3000` -- wait for specific port to be listening (via `detectPorts`)
- `port: true` -- wait for ANY port to appear on the service process
- `port: () => number` -- dynamic port resolved at check time

```ts
ready: { port: 3000 }
ready: { port: true }
ready: { port: () => parseInt(process.env.PORT ?? "3000") }
```

### Output

```ts
ready: { output: RegExp | ((line: string) => boolean) }
```

Captures the **last 200 lines** from the tmux pane and tests each line.

- `RegExp` -- `lines.some(line => regex.test(line))`
- `function` -- `lines.some(fn)`

```ts
ready: { output: /WORKER_INITIALIZED/ }
ready: { output: (line) => line.includes("ready") }
```

### Docker

```ts
ready: { docker: string; file?: string }
```

Polls `docker compose ps --format json` for the named container. Ready when:
- `state === "running"` AND
- no healthcheck (`health === ""`) OR `health === "healthy"`

`file` overrides the compose file path; falls back to the service's `docker.file` or project default.

**Auto-detection**: when a service has `docker` config but no explicit `ready`, ZAPS automatically uses `{ docker: config.docker.service }`.

```ts
ready: { docker: "postgres" }
ready: { docker: "redis", file: "docker-compose.dev.yml" }
```

### HTTP

```ts
ready: { http: string | { url: string; status?: number } }
```

Two modes based on URL format:

| Input | Behavior |
|---|---|
| `"/path"` (starts with `/`) | Waits for ANY port first (like `port: true`), then probes `http://localhost:{port}{path}` |
| `"http://..."` (full URL) | Probes URL directly, no port wait |

Per-attempt: `GET` request, `redirect: "manual"`, **1s timeout**.

- No `status` specified: any response that doesn't throw is success (including 4xx/5xx)
- `status` specified: response must match exactly

```ts
ready: { http: "/health" }
ready: { http: "http://localhost:8080/api/status" }
ready: { http: { url: "/ready", status: 200 } }
```

### Custom Function

```ts
ready: () => Promise<boolean>
```

Polled every 500ms until it returns `true`.

```ts
ready: async () => {
  try { await fetch("http://localhost:3000"); return true; }
  catch { return false; }
}
```

## Options Reference

| Option | Type | Description |
|---|---|---|
| `port` | `number \| true \| () => number` | Wait for port to be listening |
| `output` | `RegExp \| (line: string) => boolean` | Match against tmux pane output |
| `docker` | `string` | Docker Compose service name to poll |
| `docker.file` | `string?` | Override compose file path |
| `http` | `string \| { url, status? }` | HTTP endpoint to probe |
| `http.status` | `number?` | Expected HTTP status code |
| `() => Promise<boolean>` | function | Custom polling function |

## Gotchas

- **Timeout is fixed at 60s** -- not configurable per-service; throws `"Ready check timed out after 60s"`
- **Output checks last 200 lines** -- older output is not visible to the matcher
- **Docker readiness includes healthcheck** -- container must be `running` AND healthy (if healthcheck exists)
- **HTTP without `status`** -- any response passes, even 500s; only connection failures retry
- **HTTP relative path** -- triggers port detection first, adding latency before HTTP probing starts
- **Docker auto-detection** -- happens silently when `docker` config is set without `ready`; set `ready` explicitly to override
