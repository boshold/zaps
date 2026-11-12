# Tasks — TaskConfig

## Recommended Development Tasks

Define common checks as manual tasks. Use clear keys and `pnpm` commands in pnpm projects:

```ts
tasks: {
  setup: {
    name: "Install dependencies",
    commands: "pnpm install",
  },
  migrate: {
    name: "Run migrations",
    commands: "pnpm prisma migrate dev",
    shortcut: "m",
  },
  seed: {
    name: "Seed database",
    commands: "pnpm prisma db seed",
    dependsOn: ["migrate"],
    shortcut: "s",
  },
  lint: {
    name: "Lint",
    commands: "pnpm lint",
    shortcut: "l",
    popup: true,
  },
  typecheck: {
    name: "Typecheck",
    commands: "pnpm typecheck",
    shortcut: "t",
    popup: true,
  },
  test: {
    name: "Test",
    commands: "pnpm test",
    popup: true,
  },
}
```

Keep these manual unless the project requires an automatic step. A project `onBeforeStart` hook is suitable for required setup because a failure aborts project startup. A database `onReady` hook can run a migration after readiness, but per-service hook failures are logged without failing the service lifecycle.

Give database tasks the same dynamic database environment as the app when they need it. See the complete development setup in the services reference.

## Options

| Field         | Type                                             | Default | Description                                                   |
| ------------- | ------------------------------------------------ | ------- | ------------------------------------------------------------- |
| `name`        | `string`                                         | —       | Display name shown in TUI                                     |
| `description` | `string`                                         | —       | Optional description                                          |
| `commands`    | `Command \| Command[]`                           | —       | Shell command(s) to execute                                   |
| `run`         | `(ctx: TaskRunContext) => Promise<void>`         | —       | Programmatic task function                                    |
| `popup`       | `boolean \| { width?: string; height?: string }` | —       | Configured hook popup preference; public runs stay background |
| `shortcut`    | `string`                                         | —       | Display hint in the task picker                               |
| `dependsOn`   | `string[]`                                       | —       | Task keys that must complete first                            |
| `services`    | `string[]`                                       | `[]`    | Service keys or group names that must be ready first          |
| `autoStart`   | `boolean`                                        | `false` | Start missing `services` instead of failing; needs `services` |
| `cwd`         | `string`                                         | —       | Working directory for the task                                |
| `env`         | `EnvConfig`                                      | —       | Environment variables                                         |
| `sentra`      | `boolean \| { env: Record<string, string> }`     | —       | Inject a Sentry DSN ([Sentra](11-sentra.md))                  |

**Required**: Every task must have exactly one of `commands` or `run` — not both.

## commands vs run

- `commands` — shell commands executed sequentially. Can be a string, function returning a string, or an array of either.
- `run` — programmatic function receiving a `TaskRunContext`. Full control over execution flow.

These are **mutually exclusive**. Validation rejects configs with both.

## Command Execution

`Command` is `string | (() => string)`. Functions are called at execution time.

```ts
// Single string
commands: "npm run seed";

// Function (resolved at run time)
commands: () => `node seed.js --env=${process.env.NODE_ENV}`;

// Array — executed sequentially, stops on failure
commands: ["node -e \"console.log('migrating...')\"", "node -e \"console.log('done!')\""];
```

## Programmatic Tasks — TaskRunContext

Tasks with `run` receive a context object:

| Property     | Type                                  | Description                                                 |
| ------------ | ------------------------------------- | ----------------------------------------------------------- |
| `exec`       | `(cmd, opts?) => Promise<ExecResult>` | Execute a shell command                                     |
| `stdout`     | `{ write(text: string): void }`       | Write directly to task output                               |
| `services`   | `ServiceContext`                      | Access running services                                     |
| `projectDir` | `string`                              | Resolved project directory                                  |
| `url`        | `(service, opts?) => string \| null`  | Build a URL from a service port (also `ctx.services.url()`) |

`exec` options: `{ cwd?: string; env?: Record<string, string> }`

`ExecResult`: `{ success: boolean; exitCode: number; output: string[] }`

```ts
tasks: {
  deploy: {
    name: "Deploy",
    run: async (ctx) => {
      const result = await ctx.exec("npm run build");
      if (!result.success) {
        ctx.stdout.write("Build failed!\n");
        return;
      }
      await ctx.exec("npm run deploy");
    },
  },
}
```

## Popup

`popup` is a presentation preference for configured hook execution, including task
dependencies. It only works with `commands`; validation rejects `popup` with `run`.
Public `zaps run` and UI background requests execute the whole dependency graph in
background mode regardless of popup preferences. Accepted background runs keep
their captured config/environment and output across UI disconnect and reload.
Destroying the session stops owned child processes; JavaScript callbacks must
cooperate with cancellation.

Configured hooks use a task-owned tmux popup when supported and a usable client is
available. Shell or no usable client before launch falls back to background with
a notice. A started popup that loses its client fails once without rerunning.

| Value               | Behavior                                  |
| ------------------- | ----------------------------------------- |
| `true`              | Popup with default dimensions (80% x 80%) |
| `{ width, height }` | Custom dimensions (e.g. `"60%"`, `"40%"`) |

After all commands finish, the popup shows "Press Enter to close..." before dismissing.

```ts
tasks: {
  logs: {
    name: "View logs",
    commands: "docker logs -f app",
    popup: true,
    shortcut: "l",
  },
  shell: {
    name: "DB shell",
    commands: "docker exec -it db psql",
    popup: { width: "90%", height: "90%" },
  },
}
```

## UI modes and explicit pane runs

The in-app picker supports background execution on both backends. Shell uses
background when `ui.task.defaultMode` is `pane`, disables the `Tab` pane shortcut,
and falls back from popup pickers/output to in-app overlays. Explicit unsupported
pane requests fail instead of silently changing execution mode.

A supported explicit pane run executes only the selected task's shell commands.
It does not traverse `dependsOn` or run a programmatic `run` callback. Use a public
background run when dependency traversal is required.

## Shortcuts

`shortcut` is a **single key** shown as a hint beside the task in the `t` task picker (display-only — it does not trigger the task).

```ts
tasks: {
  seed: {
    name: "Seed data",
    commands: "node seed.js",
    shortcut: "s",
  },
}
```

If no `shortcut` is given, ZAPS auto-assigns the first character of the task key that
is not already used and not reserved.

### Reserved keys (`q`, `j`, `k`)

`q`, `j`, and `k` are **reserved** by the TUI (`q` detaches, `j`/`k` navigate lists) and are:

- **never auto-assigned** to a task, and
- **dropped** (no fallback) if a task explicitly requests one via `shortcut`.

A dropped collision prints a load-time warning naming the task, e.g.:

```
Warning: task 'deploy' ('Deploy') requests reserved shortcut 'q'; 'q' is reserved (q=quit, j/k=navigation) and the shortcut is dropped.
```

Choose any other key to keep the shortcut.

## Task Dependencies

`dependsOn` references other task keys. Dependencies run first; if any dependency fails, the dependent task is skipped.

```ts
tasks: {
  build: {
    name: "Build",
    commands: "npm run build",
  },
  deploy: {
    name: "Deploy",
    commands: "npm run deploy",
    dependsOn: ["build"],
  },
}
```

## Required Services

`services` lists the services a task needs. Without it the task is independent: it runs right away, with or without a session, and starts nothing.

Mail verification that needs mailhog and the API:

```ts
services: {
  mailhog: {
    start: "mailhog",
    ready: { port: 8025 },
    flags: { start: false },
  },
  db: { start: "pnpm db", ready: { port: 5432 } },
  api: { start: "pnpm dev:api", ready: { port: 4000 }, dependsOn: ["db"] },
},
tasks: {
  verifyMail: {
    name: "Verify mail",
    commands: "pnpm verify:mail",
    services: ["mailhog", "api"],
    autoStart: true,
  },
  seed: {
    name: "Seed database",
    commands: "pnpm prisma db seed",
    services: ["db"],
  },
},
```

- Default (no `autoStart`): if a required service is not running, the task fails before any command runs, with `services_not_running` and the missing services and their states.
- `autoStart: true`: ZAPS starts the missing services plus their `dependsOn` services (here `db` for `api`), waits until they are ready, then runs the task. They keep running afterwards.
- `zaps run <task> --start` and `--no-start` override `autoStart` for one run. The TUI asks before starting when `autoStart` is not set.
- Services in `starting`/`restarting` are waited for, even without `autoStart`.
- A group name means all services of the group.
- In a `dependsOn` chain, the required services of all tasks are checked before the first task runs. A service may be auto-started when at least one task in the chain that lists it has `autoStart: true`.
- A required `optional` service that is unavailable on the machine fails the task with `service_unavailable`.
- Use `services` for tasks that talk to a running service (seed, e2e, mail checks). Leave it off for lint, typecheck, unit tests.

## Env and Cwd

```ts
tasks: {
  test: {
    name: "Run tests",
    commands: "npm test",
    cwd: "./packages/api",
    env: { NODE_ENV: "test", CI: "true" },
  },
}
```

## Triggering from Hooks

Use `task.run()` to trigger tasks from service or project hooks:

```ts
export function config({ define, task }: Library) {
  return define({
    services: {
      db: {
        start: "docker compose up db",
        ready: { port: 5432 },
        onReady: () => task.run("seed"),
      },
    },
    tasks: {
      seed: {
        name: "Seed DB",
        commands: "node seed.js",
      },
    },
  });
}
```

## Gotchas

- **`commands` and `run` are mutually exclusive** — config validation rejects both
- **`popup` only works with `commands`** — not with `run`
- **`shortcut` is a single key** — not a key combination
- **`q`, `j`, `k` are reserved** — never auto-assigned, and dropped (with a load-time warning) if requested explicitly
- **`dependsOn` references task keys** (the object key), not task `name` values
- **`services` references service keys or group names**; unknown names fail at config load
- **`autoStart` without `services` is a config error**
