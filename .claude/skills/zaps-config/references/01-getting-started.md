# Getting Started

## Config File Discovery

ZAPS walks up from cwd to filesystem root, checking each directory for config files. First match wins.

**Search order (highest priority first):**

| Filename          | Purpose                                   |
| ----------------- | ----------------------------------------- |
| `.local.zaps.mts` | Local override (gitignored by convention) |
| `local.zaps.mts`  | Local override (gitignored by convention) |
| `.local.zaps.ts`  | Local override, `.ts` variant             |
| `local.zaps.ts`   | Local override, `.ts` variant             |
| `.zaps.mts`       | Shared/committed config                   |
| `.zaps.ts`        | Shared/committed config                   |

**Gotchas:**

- `local.*` variants take priority — use them for machine-specific overrides without polluting git
- `.mts` is preferred over `.ts` (checked first)
- Discovery stops at the first directory containing any match; it does not merge configs

## File Structure

Config files must export a `config` function (named or default export). The function receives a `Library` object and must return a `ProjectConfig` via `define()`.

```ts
import type { Library } from "zaps";

export function config({ define }: Library) {
  return define({
    name: "my-project",
    services: {
      app: {
        start: "npm run dev",
        ready: { port: 3000 },
      },
    },
  });
}
```

The config function may also be `async` — return a `Promise<ProjectConfig>` when you
need to `await` before building the config:

```ts
export async function config({ define, node }: Library) {
  const pkg = JSON.parse(await node.fs.promises.readFile("package.json", "utf8"));
  return define({ name: pkg.name, services: { app: { start: "npm run dev" } } });
}
```

**Gotchas:**

- The loader checks `mod.config` first, then `mod.default` — a named `config` export is preferred
- The export must be a function, not a plain object
- `define()` validates the config via Zod and **throws a `ConfigError`** on invalid config (it never calls `process.exit` — the CLI boundary renders the error, the daemon keeps the previous config live)

## ProjectConfig Top-Level Fields

| Field      | Type                                    | Required | Description                                                            |
| ---------- | --------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `name`     | `string`                                | No       | Project name. Defaults to `basename(projectDir)`                       |
| `cwd`      | `string \| (ctx: CwdContext) => string` | No       | Override working directory for services                                |
| `services` | `Record<string, ServiceConfig>`         | **Yes**  | Service definitions (at least one required)                            |
| `tasks`    | `Record<string, TaskConfig>`            | No       | Runnable tasks                                                         |
| `layout`   | `LayoutNode`                            | No       | Custom tmux pane layout                                                |
| `hooks`    | `HooksConfig`                           | No       | Project lifecycle hooks: `onBeforeStart`, `onStart`, `onStop`          |
| `ui`       | `UiConfig`                              | No       | TUI presentation (icons, notifications, task mode, …) — see `10-ui.md` |

## CwdContext and Project Directory Resolution

When `cwd` is set, it controls the working directory for all services:

```ts
export interface CwdContext {
  configDir: string; // Directory containing the config file
  invokeDir: string; // Directory where `zaps` was invoked
}
```

**Resolution rules:**

1. **`cwd` omitted** — uses `invokeDir` (where you ran `zaps`)
2. **`cwd` is a string** — absolute paths used as-is; relative paths resolved from `configDir`
3. **`cwd` is a function** — receives `CwdContext`, return value resolved same as string

```ts
// Monorepo example: config at repo root, services run from packages/app
export function config({ define }: Library) {
  return define({
    cwd: "./packages/app",
    services: {
      /* ... */
    },
  });
}

// Dynamic resolution
export function config({ define }: Library) {
  return define({
    cwd: ({ configDir }) => `${configDir}/packages/app`,
    services: {
      /* ... */
    },
  });
}

// Walk upward for a marker file (throws ConfigError if not found)
export function config({ define, find }: Library) {
  return define({
    cwd: find.up("package.json"),
    services: {
      /* ... */
    },
  });
}
```

## Library API

The `Library` object groups everything into namespaces. Destructure what you need:

| Namespace | Member                           | Description                                                            |
| --------- | -------------------------------- | ---------------------------------------------------------------------- |
| `define`  | `(config) => config`             | Validate and return the config. Throws `ConfigError` on bad config.    |
| `find`    | `up(filename, opts?)`            | Build a `cwd` resolver that walks upward for `filename`.               |
| `cli`     | `fatal(message, opts?)`          | Abort config eval by throwing a `ConfigError`. Never returns.          |
| `cli`     | `warn / info / success(message)` | Emit a notice (stderr in the CLI; a TUI toast during a daemon reload). |
| `task`    | `run(key)`                       | Run a defined task by key. Hooks only.                                 |
| `service` | `start / stop / restart(name)`   | Control a service. Hooks only.                                         |
| `service` | `isRunning(name)`                | Whether a service is currently ready. Hooks only.                      |
| `browser` | `open(url)`                      | Open a URL in the default browser.                                     |
| `node`    | `path / fs / process / …`        | Node built-ins: `path`, `fs`, `process`, `url`, `os`, `child_process`  |

`task.*` and `service.*` are bound only while a session is running. Use them inside
service/project hooks (e.g. `onReady`), not during config definition — calling them too
early throws a clear error.

`cli.fatal(message, opts?)` is the explicit escape hatch: it throws a `ConfigError` and
returns `never`, so it composes in any value position:

```ts
export function config({ define, cli }: Library) {
  return define({
    services: {
      api: {
        start: "npm run dev",
        env: { API_KEY: process.env.API_KEY ?? cli.fatal("API_KEY is required") },
      },
    },
  });
}
```

`cli.warn` / `cli.info` / `cli.success` surface a short message without aborting (a styled
stderr line in a one-shot CLI run; a transient toast during a daemon reload).

`node` is available immediately (not just in hooks) — use it in config expressions like `cwd`:

```ts
export function config({ define, node }: Library) {
  return define({
    cwd: ({ configDir }) => node.path.join(configDir, "backend"),
    services: {
      api: {
        start: "npm run dev",
        env: { HOME: node.process.env.HOME ?? "" },
      },
    },
  });
}
```

```ts
export function config({ define, service }: Library) {
  return define({
    services: {
      db: { start: "docker compose up db", ready: { port: 5432 } },
      app: {
        start: "npm run dev",
        ready: { port: 3000 },
        dependsOn: ["db"],
      },
    },
    hooks: {
      onStart: async () => {
        // Runtime actions available in hooks
        await service.restart("db");
      },
    },
  });
}
```

## Config Loading & Reload

Configs are evaluated with [jiti](https://github.com/unjs/jiti). Every load re-evaluates the **whole** import graph — the entry config plus all relative helper/env files it imports — so you can split a config across modules and a reload picks up edits to any of them.

Caveats (jiti uses a per-load CJS transform):

- No ESM live bindings — exports are snapshotted at load time.
- Module identity changes per load: objects/classes from one load are not `===`/`instanceof` identical across loads. Don't rely on cross-reload identity.
- `node_modules` reached from a config are re-evaluated on each load (per-reload cost for heavy deps).

## Scaffolding with `zaps init`

Run `zaps init` to create a starter `.zaps.mts` in the current directory.

- Writes a `.zaps.mts` with a single placeholder service
- Fails if any config variant already exists in the directory
- Replaces `{{ZAPS_PATH}}` in the template with the resolved import path (defaults to `"zaps"`)

Generated file:

```ts
import type { Library } from "zaps";

export function config({ define }: Library) {
  return define({
    services: {
      app: {
        start: "echo 'Replace with your start command'",
        ready: { port: 3000 },
      },
    },
  });
}
```
