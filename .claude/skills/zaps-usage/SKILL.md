---
description: Use when interacting with local dev sessions/services - start/stop/inspect services, run tasks, view logs via CLI
---

# ZAPS Usage Skill

## Trigger

Activate when user asks to start/stop/manage local development sessions, run tasks, view logs, or interact with running services (not config authoring).

## First Action

When this skill loads, immediately run `zaps prime-agent` to get the current project overview (services with runtime state/ports + tasks). This primes your context before executing the user's request.

## Output

All commands automatically output TOON when `CLAUDECODE` is set.

## Usage

### Services

```
zaps ps           # list services with state/ports/url (--json)
zaps start [svc]  # start service(s), all if omitted
zaps stop [svc]   # stop service(s)
zaps restart [svc]# restart service(s)
```

### Tasks & Logs

```
zaps run <task>   # run a task (--json)
zaps tasks        # list tasks (--json)
zaps logs [svc]   # dump logs, -f to stream, --tail <n>
```

### Query

```
zaps ls           # list active sessions (--json)
zaps inspect <svc># service details (--json)
zaps config       # validate+print config (--json, --path)
zaps events       # stream daemon events (--filter <type>)
```

### Session & Daemon

```
zaps up           # attach if running, else create + start + attach TUI
zaps up -d        # create + start services detached (no TUI); attach later with `zaps attach`
zaps down         # stop all services and destroy the session
zaps daemon stop  # full cleanup: stops every service in every session, then shuts the daemon down
                  #   prints `Stopped <n> session(s), <m> service(s).`
```

### Other

```
zaps --help # see all functions
```

## Behavior Notes

- **Detached services** (`detached: true`) and detached sessions (`zaps up -d`) run
  pane-less — there is no terminal to scroll. Read their output with
  `zaps logs <svc>` (`-f` to stream). Lifecycle (`start`/`stop`/`restart`) works normally.
- **Config reload** is validate-then-swap: an invalid edit is reported and the running
  session keeps the old config (it is never torn down). In the TUI, a changed config
  shows a `config changed — press c to reload` header hint; press `c` (when idle) to apply.
- **`--tail <n>`** on `zaps logs` must be a positive integer; otherwise the command
  errors with `Invalid --tail value "<x>": expected a positive integer.`
- **`zaps events`** validates the resolved session before subscribing — if no matching
  session exists it errors immediately instead of hanging.
- **Error messages** you may surface to the user:
  - `Port 5432 already in use (pid 1234 postgres)` — a service's expected port is taken
    (pre-flight, before start). Free the port or stop the owning process.
  - `Dependency "db" not ready` — shown as a service's error when a `dependsOn` target
    never became ready; fix or start the dependency first.
- **Removed env vars:** `ZAPS_PANE_MAP` and `ZAPS_IPC_SOCKET` no longer exist (they never
  worked) — ignore any references to them.

### AI

```
zaps prime-agent  # TOON overview of services (runtime state/ports) + tasks
```

## Core Workflow

Restart dev after package install:

```
pnpm install @example/pkg
zaps restart dev
```

Get details for testing:

```
zaps ps
agent-browser open http://localhost:3000 # Open dev
agent-browser open http://localhost:8025 # Open Mailpit for E-Mail
```

Run prisma migration:

```
zaps run prisma:migrate
```

Now run `zaps prime-agent` to prime your context.
