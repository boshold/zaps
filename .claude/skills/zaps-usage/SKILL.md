---
name: zaps-usage
description: Use when interacting with local dev sessions - start/stop services, run tasks, view logs, and manage sessions via CLI
---

# ZAPS Usage Skill

## Trigger

Activate when user asks to start/stop/manage local development sessions, run tasks, view logs, or interact with running services (not config authoring).

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

### Other

```
zaps --help # see all functions
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
