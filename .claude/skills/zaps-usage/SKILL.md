---
name: zaps-usage
description: Run or inspect ZAPS development services and tasks. Use for service status, ports, URLs, logs, start, stop, restart, task execution, config reload, or app runtime errors captured from Sentry SDKs (zaps sentra). Not for editing ZAPS configs; use zaps-config.
---

# ZAPS usage

Run `zaps prime-agent` outside the sandbox, then follow its instructions.

If it reports `Daemon not running.`, tell the user to start their ZAPS session outside the sandbox, then retry it. Tasks are the exception: they work without a session (see below).

## Run tasks

`zaps run <task>` and `zaps tasks` work without `zaps up`. Without a session, `zaps tasks` reads the config, and `zaps run` creates a background session for the run. The session is removed afterwards unless services were started for the task; then it stays and `zaps ls` shows `task-only`.

```bash
zaps tasks                 # key, name, description, [services: ... · autostart]
zaps run lint              # independent task: runs right away
zaps run seed --start      # start missing required services first
zaps run seed --no-start   # never start services, even with autoStart
```

Service progress (`Starting db…`, `db ready`) goes to stderr, task output to stdout.

When a required service is not running and starting is not allowed, the task does not run and the command exits 1. With a running session:

```
Error: Task "seed" needs services that are not running: db (stopped)
Start them with "zaps start db" or rerun with --start.
```

Without a session (the background session is already gone, so `zaps start` would not help):

```
Error: Task "seed" needs services that are not running: db (stopped)
Rerun with --start, or run "zaps up" first.
```

React like this:

- Rerun with `--start` if starting the services is fine for the user, or run `zaps start <service>` first.
- `service_start_failed`: the service failed or did not get ready. Check `zaps logs <service>`.
- `service_unavailable`: an optional service is not available on this machine. Starting does not help; tell the user.
- `uses raw input, which needs tmux`: the config has a `raw: true` service. The user must run `zaps up` first.
- `Warning: config changed since the session loaded it`: the task still ran with the old config. Suggest `zaps reload`.

MCP clients: `tasks_run` takes an optional `start` (`true` = `--start`, `false` = `--no-start`, omitted = the task's `autoStart`) and also works without a session. `tasks_list` shows `requiredServices` and `autoStart` per task.

## Inspect app runtime errors

Use this when `prime-agent` shows `sentra.status` other than `disabled`. Services listed under `sentra.services` send their Sentry SDK errors to ZAPS.

1. Record the start time, then reproduce the bug or run the tests:

   ```bash
   T0=$(date -Iseconds)
   pnpm test:e2e            # or click through the app, call the API, ...
   ```

2. List what failed since then:

   ```bash
   zaps sentra errors --from "$T0"
   zaps sentra errors --from "$T0" --service web --fail-if-any   # exit 1 when anything matches
   ```

3. Read one record (stack trace, request, breadcrumbs) by its `id` or `issueId`:

   ```bash
   zaps sentra show <id>
   ```

4. Fix, then repeat from step 1 with a new `T0`.

Other commands:

- `zaps sentra issues --since 1h` groups records by fingerprint, last seen first.
- `zaps sentra clear` deletes the session's records before a clean run. `--service <s>` and `--before <time>` narrow it.
- `zaps ps` shows `ERRORS` per service: errors since that service last started.
- MCP clients get the same data from the `sentra_errors`, `sentra_issues` and `sentra_show` tools (same filters; list tools end with `hasMore`). Like the CLI, they start the daemon when needed.
- `zaps sentra live --service web` streams new errors until Ctrl-C. Only for a user-visible pane; agents should poll `errors --from` instead.

Notes:

- Times: ISO 8601, epoch ms, or a duration meaning "now minus" (`10m`). `--since <duration>` can't be combined with `--from`. `--to` sets the end.
- Defaults: `errors` shows `--kind error,message --min-level error`. Any `--kind`, `--level` or `--min-level` flag drops the level default.
- Filters: `--service` and `--level` repeat; `--kind error,message`; `--q <text>` matches the title. Values starting with `-` need `=` (`--q=-foo`).
- Paging: `--limit` (default 20, max 500). When the output ends with `next: <command>`, run that command for the next page.
- `location` is the crashing frame; without source maps it is an absolute `path:line:col`.
- `receivedAt` is UTC.
- Query commands work after `zaps down` and start the daemon if needed, so errors from a stopped session stay readable.
- Exit codes: `0` ok; `1` Sentra disabled or unavailable, unknown flag, or `--fail-if-any` matched; `2` invalid flag value.
- `Sentra is not enabled for this project` means the config has no `sentra` setup. Use the zaps-config skill to add one if the user wants it.
