---
name: zaps-usage
description: Use when running or inspecting local dev services through the ZAPS CLI — starting/stopping/restarting services, attaching the TUI (`zaps up`/`attach`), running tasks, streaming logs, checking which services are running and on what ports, reloading config, or managing the daemon. Trigger whenever the user wants to bring up, tear down, restart, or check the status of their local dev environment with zaps — including single-command asks like "restart the api", "what ports are my services on", "list running services", or "tail the web logs" — so the exact zaps command, flags, and session targeting are correct. Not for authoring config files — use the zaps-config skill for that.
---

# ZAPS Usage Skill

## Trigger

Activate when user asks to start/stop/manage local development sessions, run tasks, view logs, or interact with running services (not config authoring).

## First Action

When this skill loads, immediately run `zaps prime-agent` to get the current project overview (services with runtime state/ports + tasks). This primes your context before executing the user's request.

## Output

Query/service commands print a human table by default. For machine-readable output pass
`--json` (pretty JSON) or `--toon` ([TOON](https://github.com/toon-format/toon)), or set
`ZAPS_FORMAT=json|toon` to make it the default for every command. Coding agents are
auto-detected (`CLAUDECODE` / `CURSOR_TRACE_DIR`) and default to **TOON** with no flag.

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
zaps up             # attach if running, else create + start + attach TUI
zaps up -d          # create + start services detached (no TUI); attach later with `zaps attach`
zaps attach         # attach the TUI to a running session (use `-s <id|name>` to pick one)
zaps reload         # reload config for the running session (CLI form of the dashboard `c`)
zaps down           # stop all services and destroy the session
zaps daemon start   # start the background daemon (usually implicit via `zaps up`)
zaps daemon status  # daemon PID + session list (--json / --toon)
zaps daemon ping    # check the daemon is responsive
zaps daemon stop    # full cleanup: stops every service in every session, then shuts the daemon down
                    #   prints `Stopped <n> session(s), <m> service(s).`
```

Target a specific session with the global `-s, --session <id|name>` flag (before the
command): `zaps -s my-app down`, `zaps -s my-app restart api`. Without it, ZAPS resolves
the session for the current directory.

### TUI

`zaps up` attaches the interactive dashboard. Key interactions:

```
Global
  Ctrl-K / :  command palette (fuzzy actions)
  ?           help overlay
  t           task picker
  f           open the latest failure's captured output
  x           acknowledge (clear sticky failure toasts)
  q / Ctrl-C  detach (services keep running)
  Ctrl-D      shut down the session
  Esc         close overlay / leave view

Dashboard
  ↑↓ / j k    navigate services
  r / s       restart / start-stop selected
  a / c       restart all / reload config
  l / o       logs / open URL
  R           docker rebuild     z / Z  zoom service / TUI pane
  E           edit-capture pane  d      shut down session

Task picker (t)
  type        fuzzy filter
  Enter       run in the default mode (ui.task.defaultMode, default background)
  Tab         run live in a tmux pane
  Esc         close

Log view (l)
  ↑↓ / j k    scroll (scroll to bottom resumes live follow)
  Esc         back
```

**Run modes:** a task launched with `Enter` runs in the configured default mode
(`background` unless `ui.task.defaultMode: pane`); `Tab` always runs it live in a
tmux pane that stays open on completion. Background runs notify via a toast —
transient on success, sticky on failure (ack with `x`); failures also fire an
out-of-band terminal notification per `ui.notifications`. Press `f` for the
failed-output overlay, then `p` to escalate to a tmux popup.

### Other

```
zaps --help # see all functions
```

## Behavior Notes

- **Detached services** (`detached: true`) and detached sessions (`zaps up -d`) run
  pane-less — there is no terminal to scroll. Read their output with
  `zaps logs <svc>` (`-f` to stream). Lifecycle (`start`/`stop`/`restart`) works normally.
- **Lazy panes (non-autostart services).** A service with `flags.start: false`
  (or explicit `lazyPane: true`) now boots **pane-less** — its tmux pane only
  appears when you `zaps start <svc>` (or restart from stopped), at its
  declared layout position; a `zaps stop <svc>` drops the pane and re-expands
  survivors. Crash + restart keep the pane. `zaps logs <svc>` returns `[]`
  before the first start, streams live while the service is running, and
  returns the retained history after stop. To reserve an empty pane at boot
  instead, set `lazyPane: false` on the service.
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
