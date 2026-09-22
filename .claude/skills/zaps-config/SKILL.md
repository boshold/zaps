---
name: zaps-config
description: Create, edit, or explain ZAPS .zaps.mts/.zaps.ts configs, including local overrides, services, tasks, dependencies, readiness, Docker, hooks, layout, and UI. Use for config changes even when the user does not name the file. For running services, use zaps-usage.
---

# ZAPS config

Read only the references relevant to the request. Check the installed ZAPS version when an example may differ from the project's API.

| Reference                                           | Read for                                                     |
| --------------------------------------------------- | ------------------------------------------------------------ |
| [Getting started](references/01-getting-started.md) | Discovery, config shape, Library API, scaffolding            |
| [Services](references/02-services.md)               | Commands, optional services, restart, and the full dev setup |
| [Ready detection](references/03-ready-detection.md) | Port, output, Docker, HTTP, custom checks                    |
| [Docker](references/04-docker.md)                   | Compose services and readiness                               |
| [Environment](references/05-environment.md)         | Static and dynamic env, ServiceContext                       |
| [Dependencies](references/06-dependencies.md)       | Startup order and `restartWith`                              |
| [Tasks](references/07-tasks.md)                     | Commands, `run`, shortcuts, task dependencies                |
| [Layout](references/08-layout.md)                   | Pane placement and sizing                                    |
| [Hooks](references/09-hooks.md)                     | Lifecycle actions and cross-service restarts                 |
| [UI](references/10-ui.md)                           | TUI options                                                  |

## Defaults for new configs

- Use `@bosdev/zaps` for `Library`, unless the project has a different installed package or a local type import.
- Export `config({ define }: Library)` and return `define({ services: { ... } })`.
- Use `pnpm` for commands in pnpm projects. Follow the project's package manager elsewhere.
- Do not add `flags.open: true` or `browser.open()` unless the user asks for browser opening. An explicit `url` can still appear in the TUI.
- Keep setup, migration, and seed tasks manual unless startup needs them. If a task must run before a service, use the relevant hook and check its failure behavior.
- For custom layouts, put `@tui` at the top left with enough room to read it, and focus it. Start with the 60% wide, 60% high pattern in the layout reference, then adapt to the project.
- Distinguish an unavailable optional service (`optional`) from one that is installed but starts only on request (`flags.start: false`). Use both when both apply.
