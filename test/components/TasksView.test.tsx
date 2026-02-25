import { EventEmitter } from "node:events";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import type { ResolvedConfig } from "../../src/config/types.js";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { TasksView } from "../../src/components/TasksView.js";
import { AppProvider } from "../../src/hooks/useZaps.js";

function makeConfig(tasks: ResolvedConfig["project"]["tasks"] = {}): ResolvedConfig {
  return {
    project: {
      name: "test-project",
      services: {},
      tasks,
    },
    configPath: "/fake/.zaps.ts",
    projectDir: "/fake",
  };
}

function createMockClient(): DaemonClient {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
    session: "test",
    attach: vi.fn().mockResolvedValue({
      configPath: "/fake/.zaps.ts",
      projectDir: "/fake",
      paneMap: {},
      statuses: [],
    }),
    destroySession: vi.fn().mockResolvedValue(undefined),
    listServices: vi.fn().mockResolvedValue([]),
    startService: vi.fn().mockResolvedValue(undefined),
    stopService: vi.fn().mockResolvedValue(undefined),
    restartService: vi.fn().mockResolvedValue(undefined),
    getLogSnapshot: vi.fn().mockResolvedValue([]),
  });
  return client as unknown as DaemonClient;
}

describe("TasksView", () => {
  it("renders all tasks from config", () => {
    const config = makeConfig({
      migrate: { name: "Run migrations", commands: "pnpm db:migrate" },
      seed: { name: "Seed DB", commands: "pnpm db:seed" },
    });
    const client = createMockClient();

    const { lastFrame } = render(
      <AppProvider client={client} config={config} paneMap={{}}>
        <TasksView
          selectedIndex={0}
          runTrigger={0}
          taskShortcuts={[]}
          taskHistory={[]}
          onTaskComplete={vi.fn()}
        />
      </AppProvider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Run migrations");
    expect(frame).toContain("Seed DB");
  });

  it("highlights selected task", () => {
    const config = makeConfig({
      migrate: { name: "Run migrations", commands: "pnpm db:migrate" },
      seed: { name: "Seed DB", commands: "pnpm db:seed" },
    });
    const client = createMockClient();

    const { lastFrame } = render(
      <AppProvider client={client} config={config} paneMap={{}}>
        <TasksView
          selectedIndex={1}
          runTrigger={0}
          taskShortcuts={[]}
          taskHistory={[]}
          onTaskComplete={vi.fn()}
        />
      </AppProvider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(">");
  });

  it("renders Tasks header", () => {
    const config = makeConfig({
      migrate: { name: "Run migrations", commands: "pnpm db:migrate" },
    });
    const client = createMockClient();

    const { lastFrame } = render(
      <AppProvider client={client} config={config} paneMap={{}}>
        <TasksView
          selectedIndex={0}
          runTrigger={0}
          taskShortcuts={[]}
          taskHistory={[]}
          onTaskComplete={vi.fn()}
        />
      </AppProvider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tasks");
  });

  it("renders help bar with controls", () => {
    const config = makeConfig({
      migrate: { name: "Run migrations", commands: "pnpm db:migrate" },
    });
    const client = createMockClient();

    const { lastFrame } = render(
      <AppProvider client={client} config={config} paneMap={{}}>
        <TasksView
          selectedIndex={0}
          runTrigger={0}
          taskShortcuts={[]}
          taskHistory={[]}
          onTaskComplete={vi.fn()}
        />
      </AppProvider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[enter] run");
    expect(frame).toContain("[q/esc] back");
  });

  it("renders empty when no tasks defined", () => {
    const config = makeConfig({});
    const client = createMockClient();

    const { lastFrame } = render(
      <AppProvider client={client} config={config} paneMap={{}}>
        <TasksView
          selectedIndex={0}
          runTrigger={0}
          taskShortcuts={[]}
          taskHistory={[]}
          onTaskComplete={vi.fn()}
        />
      </AppProvider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tasks");
    // Should not crash
  });
});
