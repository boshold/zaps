---
name: zaps-usage
description: Use when interacting with running ZAPS sessions — start/stop services, run tasks, view logs, and manage sessions via the CLI.
---

# ZAPS Usage Skill

## Trigger

Activate when user asks to start/stop/manage zaps sessions, run tasks, view logs, or interact with running services (not config authoring).

## Session Lifecycle

```
zaps              # attach or create+start+attach
zaps up -d        # start detached (no TUI)
zaps down         # stop all + destroy session
```

## Services

```
zaps start [svc]  # start service(s), all if omitted
zaps stop [svc]   # stop service(s)
zaps restart [svc]# restart service(s)
zaps ps           # list services with state/ports/url (--json)
```

## Tasks & Logs

```
zaps run <task>   # run a task (--json)
zaps tasks        # list tasks (--json)
zaps logs [svc]   # dump logs, -f to stream, --tail <n>
```

## Query

```
zaps ls           # list active sessions (--json)
zaps inspect <svc># service details (--json)
zaps config       # validate+print config (--json, --path)
zaps events       # stream daemon events (--filter <type>)
```

## Other

```
zaps init         # scaffold starter config
zaps attach [ses] # attach TUI to running session
zaps daemon start|stop|status
```

## Global Flag

```
-s, --session <id> — target specific session
```