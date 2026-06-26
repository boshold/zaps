# Environment Variables — EnvConfig & ServiceContext

## EnvConfig Type

`env` accepts a static record or a dynamic function:

```ts
type EnvValue = string | null | undefined;
type EnvConfig = Record<string, EnvValue> | ((ctx: ServiceContext) => Record<string, EnvValue>);
```

| Form                                | Description                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `Record<string, EnvValue>`          | Static key-value pairs, resolved immediately                                 |
| `(ctx) => Record<string, EnvValue>` | Dynamic function, called at service start time with current `ServiceContext` |

A `null` or `undefined` value is **dropped** — the variable is omitted rather than set to
`""`. This makes `ctx.url()` (which returns `string | null`) safe to use directly in env,
with no `?? ""` fallback needed.

## ServiceContext Shape

```ts
interface ServiceContext {
  services: Record<
    string,
    {
      port: number | undefined; // First detected port (shorthand)
      ports: number[]; // All detected ports
      cwd: string | undefined; // Service's configured `cwd`, else the project dir
    }
  >;
  projectDir: string; // Resolved project root
  url(service: string, opts?: UrlOptions): string | null; // Build a URL from a service port
}
```

- `services` is keyed by service name — access any service's runtime info
- `port` is `undefined` if the service hasn't reported a port yet
- `cwd` is the service's configured `cwd` (resolved), or `projectDir` when the service sets none
- `projectDir` is the resolved working directory for the project
- `url()` builds `{protocol}://{auth@}{host}:{port}{path}` from a service's detected port

## Building URLs with `ctx.url()`

`ctx.url(service, opts?)` is the ergonomic way to derive a service URL instead of
hand-interpolating ports. It returns `null` when the port isn't detected yet (and that
`null` is dropped from env), and **throws `ConfigError`** for an unknown service.

```ts
interface UrlOptions {
  protocol?: string; // default "http"
  auth?: string; // e.g. "user:pass"
  host?: string; // default "localhost"
  port?: number; // override the detected port
  path?: string; // e.g. "/mydb" (a leading "/" is added if missing)
}
```

```ts
services: {
  db: { start: "docker compose up db", ready: { port: 5432 } },
  api: {
    start: "node server.js",
    dependsOn: ["db"],
    env: (ctx) => ({
      // postgres://user:pass@localhost:5432/mydb
      DATABASE_URL: ctx.url("db", { protocol: "postgres", auth: "user:pass", path: "/mydb" }),
    }),
  },
}
```

In task `run` callbacks, the same helper is reachable as `ctx.services.url()` (and the
mirrored `ctx.url()`).

## How Env Vars Are Applied

By default, env vars are passed to the service process via an internal wrapper — they are **not visible** in tmux pane scrollback. This prevents accidental credential leaks during screen shares.

With `raw: true`, env vars are prepended as inline shell variables (visible in pane):

```sh
NODE_ENV='development' PORT='3000' npm run dev
```

Values are shell-escaped with single quotes. Internal single quotes are escaped as `'\''`.

## Static Env

```ts
services: {
  api: {
    start: "node server.js",
    env: { NODE_ENV: "development", PORT: "3000" },
  },
}
```

## Dynamic Env — Cross-Service References

Use a function to reference other services' ports or project paths:

```ts
services: {
  db: {
    start: "docker compose up db",
    ready: { port: 5432 },
  },

  api: {
    start: "node server.js",
    dependsOn: ["db"],
    env: (ctx) => ({
      DATABASE_URL: `postgres://localhost:${ctx.services.db.port}/mydb`,
      PROJECT_ROOT: ctx.projectDir,
    }),
  },

  web: {
    start: "npm run dev",
    dependsOn: ["api"],
    env: (ctx) => ({
      API_URL: `http://localhost:${ctx.services.api.port}`,
    }),
  },
}
```

## Task Env

Tasks support `env` the same way as services — both static and dynamic forms work identically:

```ts
tasks: {
  migrate: {
    name: "Run migrations",
    commands: "prisma migrate deploy",
    env: (ctx) => ({
      DATABASE_URL: `postgres://localhost:${ctx.services.db.port}/mydb`,
    }),
  },
}
```

## Gotchas

- **Dynamic env resolves at start time** — the function runs when the service/task starts, not when config is loaded
- **Ports may be `undefined`** — if a dependency hasn't detected its port yet, `ctx.services.*.port` is `undefined`. Use `dependsOn` to guarantee dependent services are ready before start
- **All values must be strings** — numbers, booleans etc. must be string-encoded (`"3000"`, `"true"`)
- **Shell escaping is automatic** — values are single-quoted; you don't need to escape them yourself
