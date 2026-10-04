# Sentra — Sentry SDK errors

The daemon runs a local Sentry receiver. Opted-in services and tasks get their own DSN
through env. Errors are read with `zaps sentra errors|issues|show|live|clear` (see the
zaps-usage skill), `zaps ps` (`ERRORS` column), `zaps prime-agent` and the MCP
`sentra_*` tools. Only add it when the app uses a Sentry SDK or the user asks for it.

## Config

```ts
export function config({ define }: Library) {
  return define({
    sentra: {
      env: { SENTRY_DSN: "{dsn}", NUXT_PUBLIC_SENTRY_DSN: "{dsn}", SENTRY_ENABLED: "true" },
    },
    services: {
      web: { start: "pnpm dev", sentra: true },
      api: { start: "pnpm api", sentra: { env: { SENTRY_DSN: "{dsn}" } } },
      db: { docker: { service: "postgres" } },
    },
    tasks: {
      e2e: { name: "E2E", commands: "pnpm test:e2e", sentra: true },
    },
  });
}
```

| Field                    | Type                                         | Default | Description                                                                 |
| ------------------------ | -------------------------------------------- | ------- | --------------------------------------------------------------------------- |
| `sentra.env`             | `Record<string, string>`                     | —       | Env template. `{dsn}` becomes the DSN; other values are passed as-is        |
| `sentra.enabled`         | `boolean`                                    | `true`  | `false` turns Sentra off for every service and task                         |
| `services.<name>.sentra` | `boolean \| { env: Record<string, string> }` | off     | `true`: project template. `{ env }`: own template replacing the project one |
| `tasks.<key>.sentra`     | `boolean \| { env: Record<string, string> }` | off     | Same as services                                                            |

- Sentra counts as enabled when `enabled` is not `false` and there is a top-level block
  or any service/task has its own `{ env }`. So `sentra: { env }` on one service works
  without a top-level block.
- Each service/task gets its own DSN:
  `http://sentra@127.0.0.1:<port>/<project>/<session>/<service>/1`.
- Env precedence (low to high): calling shell env, Sentra env, the service/task `env`.
  An explicit `env` key with the same name wins over Sentra.
- Tasks get the env in every mode (daemon, popup, pane).
- The receiver starts lazily. If it fails, services start without the Sentra env and the
  reason goes to the daemon log.

## Validation errors

| Error                                                        | Fix                                                |
| ------------------------------------------------------------ | -------------------------------------------------- |
| `sentra.env must use {dsn} in at least one value`            | Put `{dsn}` in at least one value                  |
| `sentra.env key '<key>' must match ^[A-Za-z_][A-Za-z0-9_]*$` | Use a valid env variable name                      |
| `services.<name>.sentra requires a top-level "sentra" block` | Add the block, or use `sentra: { env }`            |
| `tasks.<key>.sentra requires a top-level "sentra" block`     | Same for tasks                                     |
| `<a> and <b> both map to Sentra service "<segment>"`         | Rename one; names map to `[A-Za-z0-9._-]` segments |

## Docker

Docker services accept `sentra`, but the env reaches only the `docker compose` process.
Containers see it only if the compose file passes it on, and `127.0.0.1` inside a
container is the container itself. It works with `network_mode: host`. ZAPS logs a
warning once per service. Combined services that don't own the compose pane get no
env and stay out of Sentra. Prefer opting in the host-run app services.

## Nuxt (`@sentry/nuxt`)

`@sentry/nuxt` needs `enabled`, and the browser gets the DSN through public runtime
config (`NUXT_PUBLIC_SENTRY_DSN` fills `runtimeConfig.public.sentry.dsn`):

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["@sentry/nuxt/module"],
  runtimeConfig: { public: { sentry: { dsn: "" } } },
});
```

```ts
// sentry.client.config.ts
import * as Sentry from "@sentry/nuxt";

const dsn = useRuntimeConfig().public.sentry.dsn;
Sentry.init({ dsn, enabled: Boolean(dsn), tracesSampleRate: 0 });
```

```ts
// sentry.server.config.ts
import * as Sentry from "@sentry/nuxt";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: process.env.SENTRY_ENABLED === "true",
  tracesSampleRate: 0,
});
```

- Keep `127.0.0.1` (ZAPS sets it): browsers may resolve `localhost` to `::1`, and the
  receiver listens on IPv4 only.
- `tracesSampleRate: 0` keeps spans out of the database in dev.

## Live pane

```ts
"sentra-live": { start: "zaps sentra live --service web" },
```

`live` waits and reconnects when the daemon restarts. It needs a running session.

## Data

Stored in `$XDG_STATE_HOME/zaps/sentra.db` (fallback `~/.local/state/zaps/sentra.db`).
Sessions with no new records for 30 days are deleted; spans, transactions, logs and
other non-error records after 7 days. Not configurable.
