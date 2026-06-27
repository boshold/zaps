---
name: zaps-config
description: Use when creating or editing ZAPS config files (.zaps.mts/.zaps.ts and local./.local. variants) or the exported config() Library function. Covers service definitions (start/run/docker), making a service optional (binary/predicate checks), ready detection, docker-compose integration, tasks, layout/panes, hooks, dependencies, restart behavior (restartWith), environment, and the ui block. Trigger whenever the user adds, changes, or marks optional a service, task, ready check, dependency, or layout in a ZAPS project, scaffolds via `zaps init`, or asks how a ZAPS config option works — even if they don't name the file and even if the request sounds like an action ("make X optional", "add a redis service"). For running or inspecting services use the zaps-usage skill instead.
---

# ZAPS Configuration Skill

## Trigger

Activate this skill when the user:

- Asks to create or edit a `.zaps.mts` or `.zaps.ts` config file
- Asks about ZAPS configuration options or patterns
- Wants to add services, tasks, layout, hooks, or docker to a ZAPS project
- Asks about ready detection, dependencies, or environment variables in ZAPS context
- Runs `zaps init` and needs help configuring the generated file

## Reference Files

**Read the relevant reference file(s) before answering or writing config.**

| File                               | Topic                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `references/01-getting-started.md` | Config discovery, file structure, Library API (incl. `node`), scaffolding |
| `references/02-services.md`        | ServiceConfig: start/run/stop, cwd, detached, flags, url, restart         |
| `references/03-ready-detection.md` | 5 mechanisms: port, output, docker, http, custom function                 |
| `references/04-docker.md`          | DockerConfig for docker-compose integration                               |
| `references/05-environment.md`     | Static/dynamic env, ServiceContext                                        |
| `references/06-dependencies.md`    | dependsOn, topological sort, startup/stop order                           |
| `references/07-tasks.md`           | TaskConfig: commands vs run, popup, shortcuts, TaskRunContext             |
| `references/08-layout.md`          | LayoutNode tree: rows/columns, @tui pane, size/focus                      |
| `references/09-hooks.md`           | Project + per-service hooks, library actions                              |
| `references/10-ui.md`              | `ui` block: icons, notifications, failOutput, task mode, wideThreshold    |

## Config Skeleton

```ts
import type { Library } from "@bosdev/zaps";

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

The `Library` object groups everything into namespaces — destructure what you need:
`define`, `find`, `cli`, `task`, `service`, `browser`, `node`.

## Key Rules

- Config file must export a `config` function (named export or default export)
- The function receives a `Library` object and must call `define()`
- At least one service is required in the `services` record
- Each service needs exactly one of: `start`, `run`, or `docker`
- Import the `Library` type from the `"@bosdev/zaps"` package
- The file must be `.zaps.mts` or `.zaps.ts` (TypeScript, ESM)

## Quick Reference

### Basic service with port ready

```ts
services: {
  api: {
    start: "npm run dev",
    ready: { port: 4000 },
    url: "http://localhost:4000",
  },
}
```

### Service with dependencies

```ts
services: {
  db: {
    docker: { service: "postgres" },
  },
  api: {
    start: "npm run dev",
    ready: { port: 4000 },
    dependsOn: ["db"],
  },
}
```

### Docker service

```ts
services: {
  redis: {
    docker: { service: "redis", file: "docker-compose.dev.yml" },
    ready: { port: 6379 },
  },
}
```

### Task with shortcut

```ts
tasks: {
  seed: {
    name: "Seed DB",
    commands: "npx prisma db seed",
    shortcut: "s",
  },
}
```

### UI config (all fields optional, defaults shown)

```ts
ui: {
  icons: "nerd",              // "nerd" | "unicode" | "ascii"
  notifications: "osc9",      // "off" | "bell" | "osc9" | "osc9+bell"
  failOutput: "overlay",      // "overlay" | "popup"
  wideThreshold: 100,         // min cols for the detail pane (int ≥ 40)
  task: {
    defaultMode: "background", // "background" | "pane" (Enter in the task picker)
    popupPicker: false,        // fzf tmux popup picker
  },
}
```

### Custom layout

```ts
layout: {
  direction: "columns",
  children: [
    { pane: "@tui", size: "30" },
    {
      direction: "rows",
      children: [
        { pane: "api", focus: true },
        { pane: "web" },
      ],
    },
  ],
}
```

### Optional service (binary check)

```ts
services: {
  rainfrog: {
    optional: true,
    start: "rainfrog -u postgres://localhost:5432",
    ready: { port: 5432 },
  },
}
```

### Optional service (custom predicate)

```ts
services: {
  "custom-tool": {
    optional: async () => {
      const { execSync } = await import("node:child_process");
      try { execSync("docker image inspect my-tool"); return true; }
      catch { return false; }
    },
    docker: { service: "my-tool" },
  },
}
```

### Hook that triggers a task

```ts
export function config({ define, task }: Library) {
  return define({
    services: {
      /* ... */
    },
    hooks: {
      onStart: () => task.run("setup"),
    },
    tasks: {
      setup: {
        name: "Setup",
        commands: "npm install",
      },
    },
  });
}
```
