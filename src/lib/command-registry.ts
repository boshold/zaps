import type { TaskInfo } from "#src/daemon/session.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

/** Which bucket a command belongs to — used only for grouping/labelling, not ranking. */
type CommandGroup = "context" | "global" | "task";

/** A single dispatchable palette entry. `run` reuses the same IPC the quick keys drive. */
interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  /** Optional dimmed trailing hint (target url, task shortcut, …). */
  hint?: string;
  /** Availability predicate; the command is omitted from the built registry when it returns false. */
  when?: () => boolean;
  run: () => void;
}

/**
 * Callbacks the registry dispatches into. Each maps to the exact handler/IPC a
 * quick key already drives, so the palette is a discoverable superset, never a
 * second code path. `help` is optional — it only appears once the help overlay
 * (P03-T06) wires a handler in.
 */
interface CommandActions {
  restart: (name: string) => void;
  toggle: (name: string) => void;
  restartAll: () => void;
  reloadConfig: () => void;
  openLogs: (name: string) => void;
  openUrl: (url: string) => void;
  rebuildDocker: (name: string) => void;
  zoom: (name: string) => void;
  editCapture: (name: string) => void;
  runTask: (key: string) => void;
  detach: () => void;
  shutdown: () => void;
  help?: () => void;
}

interface CommandRegistryContext {
  /** The currently highlighted service (dashboard selection), or undefined when the list is empty. */
  selected?: ServiceStatus;
  tasks: TaskInfo[];
  actions: CommandActions;
}

/** Context actions for the selected service — gated by that service's capabilities. */
function contextCommands(selected: ServiceStatus, actions: CommandActions): Command[] {
  const { name } = selected;
  const available = selected.state !== "unavailable";
  const running = selected.state === "ready" || selected.state === "starting";

  const commands: Command[] = [
    {
      id: `svc:restart:${name}`,
      title: `Restart ${name}`,
      group: "context",
      when: () => available,
      run: () => actions.restart(name),
    },
    {
      id: `svc:toggle:${name}`,
      title: `${running ? "Stop" : "Start"} ${name}`,
      group: "context",
      when: () => available,
      run: () => actions.toggle(name),
    },
    {
      id: `svc:logs:${name}`,
      title: `Logs: ${name}`,
      group: "context",
      when: () => available,
      run: () => actions.openLogs(name),
    },
    {
      id: `svc:rebuild:${name}`,
      title: `Docker rebuild: ${name}`,
      group: "context",
      when: () => available && Boolean(selected.isDocker),
      run: () => actions.rebuildDocker(name),
    },
    {
      id: `svc:zoom:${name}`,
      title: `Zoom pane: ${name}`,
      group: "context",
      when: () => available && !selected.isDetached,
      run: () => actions.zoom(name),
    },
    {
      id: `svc:edit:${name}`,
      title: `Edit-capture pane: ${name}`,
      group: "context",
      when: () => available && !selected.isDetached,
      run: () => actions.editCapture(name),
    },
  ];

  const { url } = selected;
  if (url) {
    commands.push({
      id: `svc:open:${name}`,
      title: `Open URL: ${name}`,
      group: "context",
      hint: url,
      run: () => actions.openUrl(url),
    });
  }
  return commands;
}

/** Global actions — available from any view regardless of selection. */
function globalCommands(actions: CommandActions): Command[] {
  const commands: Command[] = [
    {
      id: "global:restart-all",
      title: "Restart all services",
      group: "global",
      run: actions.restartAll,
    },
    {
      id: "global:reload-config",
      title: "Reload config",
      group: "global",
      run: actions.reloadConfig,
    },
    {
      id: "global:detach",
      title: "Detach (services keep running)",
      group: "global",
      run: actions.detach,
    },
    { id: "global:shutdown", title: "Shut down session", group: "global", run: actions.shutdown },
  ];
  const { help } = actions;
  if (help) {
    commands.push({ id: "global:help", title: "Help", group: "global", run: help });
  }
  return commands;
}

/**
 * Flatten context actions, global actions, and one entry per task into a single
 * ranked-elsewhere command list. Commands whose `when` predicate is false (e.g.
 * docker rebuild on a non-docker service) are dropped, so the palette never
 * offers an action that would no-op.
 */
function buildCommandRegistry(ctx: CommandRegistryContext): Command[] {
  const { selected, tasks, actions } = ctx;

  const taskCommands: Command[] = tasks.map((task) => ({
    id: `task:${task.key}`,
    title: `Run task: ${task.name}`,
    group: "task",
    hint: task.shortcut,
    run: () => actions.runTask(task.key),
  }));

  const all = [
    ...(selected ? contextCommands(selected, actions) : []),
    ...globalCommands(actions),
    ...taskCommands,
  ];

  return all.filter((command) => command.when === undefined || command.when());
}

export { buildCommandRegistry };
export type { Command, CommandActions, CommandGroup, CommandRegistryContext };
