# Tasks — TaskConfig

## Options

| Field         | Type                                             | Default | Description                             |
| ------------- | ------------------------------------------------ | ------- | --------------------------------------- |
| `name`        | `string`                                         | —       | Display name shown in TUI               |
| `description` | `string`                                         | —       | Optional description                    |
| `commands`    | `Command \| Command[]`                           | —       | Shell command(s) to execute             |
| `run`         | `(ctx: TaskRunContext) => Promise<void>`         | —       | Programmatic task function              |
| `popup`       | `boolean \| { width?: string; height?: string }` | —       | Run commands in a tmux popup            |
| `shortcut`    | `string`                                         | —       | Single key to trigger the task from TUI |
| `dependsOn`   | `string[]`                                       | —       | Task keys that must complete first      |
| `cwd`         | `string`                                         | —       | Working directory for the task          |
| `env`         | `EnvConfig`                                      | —       | Environment variables                   |

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

| Property     | Type                                  | Description                   |
| ------------ | ------------------------------------- | ----------------------------- |
| `exec`       | `(cmd, opts?) => Promise<ExecResult>` | Execute a shell command       |
| `stdout`     | `{ write(text: string): void }`       | Write directly to task output |
| `services`   | `ServiceContext`                      | Access running services       |
| `projectDir` | `string`                              | Resolved project directory    |

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

`popup` runs commands in a tmux popup window instead of inline. **Only works with `commands`** — validation rejects `popup` with `run`.

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

Use `lib.runTask()` to trigger tasks from service or project hooks:

```ts
export function config({ defineProject, runTask }: Library) {
  return defineProject({
    services: {
      db: {
        start: "docker compose up db",
        ready: { port: 5432 },
        onReady: () => runTask("seed"),
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
