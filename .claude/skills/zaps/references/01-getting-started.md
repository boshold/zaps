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

Config files must export a `config` function (named or default export). The function receives a `Library` object and must return a `ProjectConfig` via `defineProject()`.

```ts
import type { Library } from "zaps";

export function config({ defineProject }: Library) {
  return defineProject({
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

**Gotchas:**

- The loader checks `mod.config` first, then `mod.default` — a named `config` export is preferred
- The export must be a function, not a plain object
- `defineProject()` validates the config via Zod and returns it unchanged

## ProjectConfig Top-Level Fields

| Field      | Type                                    | Required | Description                                                              |
| ---------- | --------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `name`     | `string`                                | No       | Project name. Defaults to `basename(projectDir)`                         |
| `cwd`      | `string \| (ctx: CwdContext) => string` | No       | Override working directory for services                                  |
| `services` | `Record<string, ServiceConfig>`         | **Yes**  | Service definitions (at least one required)                              |
| `tasks`    | `Record<string, TaskConfig>`            | No       | Runnable tasks                                                           |
| `layout`   | `LayoutNode`                            | No       | Custom tmux pane layout                                                  |
| `hooks`    | `HooksConfig`                           | No       | Lifecycle hooks (`onStart`, `onStop`, `onServiceStart`, `onServiceStop`) |

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
export function config({ defineProject }: Library) {
  return defineProject({
    cwd: "./packages/app",
    services: {
      /* ... */
    },
  });
}

// Dynamic resolution
export function config({ defineProject }: Library) {
  return defineProject({
    cwd: ({ configDir }) => `${configDir}/packages/app`,
    services: {
      /* ... */
    },
  });
}
```

## Library API

The `Library` object passed to `config()` provides `defineProject` for config creation and runtime action methods usable inside hooks:

| Method             | Signature                                  | Description                                          |
| ------------------ | ------------------------------------------ | ---------------------------------------------------- |
| `defineProject`    | `(config: ProjectConfig) => ProjectConfig` | Validates and returns the config. Call exactly once. |
| `runTask`          | `(key: string) => Promise<void>`           | Run a defined task by key                            |
| `startService`     | `(name: string) => Promise<void>`          | Start a service                                      |
| `restartService`   | `(name: string) => Promise<void>`          | Restart a service                                    |
| `stopService`      | `(name: string) => Promise<void>`          | Stop a service                                       |
| `isServiceRunning` | `(name: string) => boolean`                | Check if a service is running                        |
| `openInBrowser`    | `(url: string) => Promise<void>`           | Open a URL in the default browser                    |

Runtime methods (`runTask`, `startService`, etc.) are bound after config loading. Use them in service/project hooks, not during config definition.

```ts
export function config({ defineProject, restartService }: Library) {
  return defineProject({
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
        await restartService("db");
      },
    },
  });
}
```

## Scaffolding with `zaps init`

Run `zaps init` to create a starter `.zaps.mts` in the current directory.

- Writes a `.zaps.mts` with a single placeholder service
- Fails if any config variant already exists in the directory
- Replaces `{{ZAPS_PATH}}` in the template with the resolved import path (defaults to `"zaps"`)

Generated file:

```ts
import type { Library } from "zaps";

export function config({ defineProject }: Library) {
  return defineProject({
    services: {
      app: {
        start: "echo 'Replace with your start command'",
        ready: { port: 3000 },
      },
    },
  });
}
```
