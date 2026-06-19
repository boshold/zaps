import { describe, expect, it, vi } from "vitest";

import type { TaskInfo } from "../../src/daemon/session.js";
import type { CommandActions } from "../../src/lib/command-registry.js";
import { buildCommandRegistry } from "../../src/lib/command-registry.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";

function makeActions(overrides: Partial<CommandActions> = {}): CommandActions {
  return {
    restart: vi.fn(),
    toggle: vi.fn(),
    restartAll: vi.fn(),
    reloadConfig: vi.fn(),
    openLogs: vi.fn(),
    openUrl: vi.fn(),
    rebuildDocker: vi.fn(),
    zoom: vi.fn(),
    editCapture: vi.fn(),
    runTask: vi.fn(),
    detach: vi.fn(),
    shutdown: vi.fn(),
    ...overrides,
  };
}

const READY_SVC: ServiceStatus = { name: "web", state: "ready", ports: [3000], retryCount: 0 };

describe("buildCommandRegistry", () => {
  it("includes the global actions even with no selection or tasks", () => {
    const registry = buildCommandRegistry({ tasks: [], actions: makeActions() });
    const ids = registry.map((c) => c.id);
    expect(ids).toContain("global:restart-all");
    expect(ids).toContain("global:reload-config");
    expect(ids).toContain("global:detach");
    expect(ids).toContain("global:shutdown");
  });

  it("omits the help command unless a help action is wired", () => {
    const without = buildCommandRegistry({ tasks: [], actions: makeActions() });
    expect(without.map((c) => c.id)).not.toContain("global:help");

    const help = vi.fn();
    const withHelp = buildCommandRegistry({ tasks: [], actions: makeActions({ help }) });
    expect(withHelp.map((c) => c.id)).toContain("global:help");
  });

  it("adds one Run task entry per task with its shortcut as hint", () => {
    const tasks: TaskInfo[] = [
      { key: "build", name: "Build", description: null, shortcut: "b" },
      { key: "lint", name: "Lint", description: null },
    ];
    const registry = buildCommandRegistry({ tasks, actions: makeActions() });
    const taskCmds = registry.filter((c) => c.group === "task");
    expect(taskCmds.map((c) => c.title)).toEqual(["Run task: Build", "Run task: Lint"]);
    expect(taskCmds[0].hint).toBe("b");
  });

  it("reflects the selected service in context actions and dispatches them", () => {
    const actions = makeActions();
    const registry = buildCommandRegistry({ selected: READY_SVC, tasks: [], actions });
    const restart = registry.find((c) => c.id === "svc:restart:web");
    expect(restart?.title).toBe("Restart web");
    restart?.run();
    expect(actions.restart).toHaveBeenCalledWith("web");
  });

  it("titles the toggle Stop for a running service and Start for a stopped one", () => {
    const running = buildCommandRegistry({
      selected: READY_SVC,
      tasks: [],
      actions: makeActions(),
    });
    expect(running.find((c) => c.id === "svc:toggle:web")?.title).toBe("Stop web");

    const stopped = buildCommandRegistry({
      selected: { ...READY_SVC, state: "stopped" },
      tasks: [],
      actions: makeActions(),
    });
    expect(stopped.find((c) => c.id === "svc:toggle:web")?.title).toBe("Start web");
  });

  it("offers docker rebuild only for a docker service", () => {
    const plain = buildCommandRegistry({ selected: READY_SVC, tasks: [], actions: makeActions() });
    expect(plain.map((c) => c.id)).not.toContain("svc:rebuild:web");

    const docker = buildCommandRegistry({
      selected: { ...READY_SVC, isDocker: true },
      tasks: [],
      actions: makeActions(),
    });
    expect(docker.map((c) => c.id)).toContain("svc:rebuild:web");
  });

  it("filters context actions for an unavailable service to nothing actionable", () => {
    const registry = buildCommandRegistry({
      selected: { ...READY_SVC, state: "unavailable" },
      tasks: [],
      actions: makeActions(),
    });
    expect(registry.some((c) => c.group === "context")).toBe(false);
  });

  it("offers Open URL only when the service has a url", () => {
    const withUrl = buildCommandRegistry({
      selected: { ...READY_SVC, url: "http://localhost:3000" },
      tasks: [],
      actions: makeActions(),
    });
    const open = withUrl.find((c) => c.id === "svc:open:web");
    expect(open?.hint).toBe("http://localhost:3000");

    const noUrl = buildCommandRegistry({ selected: READY_SVC, tasks: [], actions: makeActions() });
    expect(noUrl.map((c) => c.id)).not.toContain("svc:open:web");
  });

  it("omits zoom / edit-capture for a detached service", () => {
    const registry = buildCommandRegistry({
      selected: { ...READY_SVC, isDetached: true },
      tasks: [],
      actions: makeActions(),
    });
    const ids = registry.map((c) => c.id);
    expect(ids).not.toContain("svc:zoom:web");
    expect(ids).not.toContain("svc:edit:web");
  });
});
