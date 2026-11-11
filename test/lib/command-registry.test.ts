import { describe, expect, it, vi } from "vitest";

import type { ProjectedServiceStatus, TaskInfo } from "../../src/daemon/session.js";
import { unavailableActions, unavailableCapabilities } from "../../src/lib/backend/wire.js";
import type { CommandActions } from "../../src/lib/command-registry.js";
import { buildCommandRegistry } from "../../src/lib/command-registry.js";
import { fullCapabilities, liveActions, mixedCapabilities } from "../_helpers/ui-capabilities.js";

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

const READY_SVC: ProjectedServiceStatus = {
  name: "web",
  state: "ready",
  ports: [3000],
  retryCount: 0,
  actions: liveActions,
};

describe("buildCommandRegistry", () => {
  it("includes the global actions even with no selection or tasks", () => {
    const registry = buildCommandRegistry({
      capabilities: fullCapabilities,
      tasks: [],
      actions: makeActions(),
    });
    const ids = registry.map((c) => c.id);
    expect(ids).toContain("global:restart-all");
    expect(ids).toContain("global:reload-config");
    expect(ids).toContain("global:detach");
    expect(ids).toContain("global:shutdown");
  });

  it("omits the help command unless a help action is wired", () => {
    const without = buildCommandRegistry({
      capabilities: fullCapabilities,
      tasks: [],
      actions: makeActions(),
    });
    expect(without.map((c) => c.id)).not.toContain("global:help");

    const help = vi.fn();
    const withHelp = buildCommandRegistry({
      capabilities: fullCapabilities,
      tasks: [],
      actions: makeActions({ help }),
    });
    expect(withHelp.map((c) => c.id)).toContain("global:help");
  });

  it("adds one Run task entry per task with its shortcut as hint", () => {
    const tasks: TaskInfo[] = [
      { key: "build", name: "Build", description: null, shortcut: "b" },
      { key: "lint", name: "Lint", description: null },
    ];
    const registry = buildCommandRegistry({
      capabilities: fullCapabilities,
      tasks,
      actions: makeActions(),
    });
    const taskCmds = registry.filter((c) => c.group === "task");
    expect(taskCmds.map((c) => c.title)).toEqual(["Run task: Build", "Run task: Lint"]);
    expect(taskCmds[0].hint).toBe("b");
  });

  it("reflects the selected service in context actions and dispatches them", () => {
    const actions = makeActions();
    const registry = buildCommandRegistry({
      capabilities: fullCapabilities,
      selected: READY_SVC,
      tasks: [],
      actions,
    });
    const restart = registry.find((c) => c.id === "svc:restart:web");
    expect(restart?.title).toBe("Restart web");
    restart?.run();
    expect(actions.restart).toHaveBeenCalledWith("web");
  });

  it("titles the toggle Stop for a running service and Start for a stopped one", () => {
    const running = buildCommandRegistry({
      capabilities: fullCapabilities,
      selected: READY_SVC,
      tasks: [],
      actions: makeActions(),
    });
    expect(running.find((c) => c.id === "svc:toggle:web")?.title).toBe("Stop web");

    const stopped = buildCommandRegistry({
      capabilities: fullCapabilities,
      selected: { ...READY_SVC, state: "stopped" },
      tasks: [],
      actions: makeActions(),
    });
    expect(stopped.find((c) => c.id === "svc:toggle:web")?.title).toBe("Start web");
  });

  it("offers docker rebuild only for a docker service", () => {
    const plain = buildCommandRegistry({
      capabilities: fullCapabilities,
      selected: READY_SVC,
      tasks: [],
      actions: makeActions(),
    });
    expect(plain.map((c) => c.id)).not.toContain("svc:rebuild:web");

    const docker = buildCommandRegistry({
      capabilities: fullCapabilities,
      selected: { ...READY_SVC, isDocker: true },
      tasks: [],
      actions: makeActions(),
    });
    expect(docker.map((c) => c.id)).toContain("svc:rebuild:web");
  });

  it("filters context actions for an unavailable service to nothing actionable", () => {
    const registry = buildCommandRegistry({
      capabilities: fullCapabilities,
      selected: { ...READY_SVC, state: "unavailable" },
      tasks: [],
      actions: makeActions(),
    });
    expect(registry.some((c) => c.group === "context")).toBe(false);
  });

  it("offers Open URL only when the service has a url", () => {
    const withUrl = buildCommandRegistry({
      capabilities: fullCapabilities,
      selected: { ...READY_SVC, url: "http://localhost:3000" },
      tasks: [],
      actions: makeActions(),
    });
    const open = withUrl.find((c) => c.id === "svc:open:web");
    expect(open?.hint).toBe("http://localhost:3000");

    const noUrl = buildCommandRegistry({
      capabilities: fullCapabilities,
      selected: READY_SVC,
      tasks: [],
      actions: makeActions(),
    });
    expect(noUrl.map((c) => c.id)).not.toContain("svc:open:web");
  });

  it.each([unavailableCapabilities, mixedCapabilities])(
    "retains nonterminal commands with %j",
    (capabilities) => {
      const registry = buildCommandRegistry({
        selected: { ...READY_SVC, isDocker: true, url: "http://localhost:3000" },
        capabilities,
        tasks: [{ key: "build", name: "Build", description: null }],
        actions: makeActions(),
      });
      expect(registry.filter((c) => c.group !== "global").map((c) => c.id)).toEqual([
        "svc:restart:web",
        "svc:toggle:web",
        "svc:logs:web",
        "svc:rebuild:web",
        "svc:open:web",
        "task:build",
      ]);
    },
  );

  it.each(["", "compose"])("omits rebuild for Docker group %j", (group) => {
    const registry = buildCommandRegistry({
      capabilities: fullCapabilities,
      selected: { ...READY_SVC, isDocker: true, group },
      tasks: [],
      actions: makeActions(),
    });
    expect(registry.map((c) => c.id)).not.toContain("svc:rebuild:web");
  });

  it("keeps zoom and logs available while a service is busy", () => {
    const registry = buildCommandRegistry({
      capabilities: fullCapabilities,
      selected: { ...READY_SVC, isDocker: true, state: "stopped" },
      selectedBusy: true,
      tasks: [],
      actions: makeActions(),
    });
    expect(registry.filter((c) => c.group === "context").map((c) => c.id)).toEqual([
      "svc:logs:web",
      "svc:zoom:web",
    ]);
  });

  it("omits zoom / edit-capture for a detached service", () => {
    const registry = buildCommandRegistry({
      capabilities: fullCapabilities,
      selected: { ...READY_SVC, isDetached: true, actions: unavailableActions },
      tasks: [],
      actions: makeActions(),
    });
    const ids = registry.map((c) => c.id);
    expect(ids).not.toContain("svc:zoom:web");
    expect(ids).not.toContain("svc:edit:web");
  });
});
