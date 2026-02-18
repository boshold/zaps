import { EventEmitter } from "node:events";

import type { ResolvedConfig } from "../../src/config/types.js";
import type { ServiceManager } from "../../src/lib/service/manager.js";
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

function createMockManager(): ServiceManager {
  const emitter = new EventEmitter();
  const manager = Object.assign(emitter, {
    getAllStatuses: vi.fn(() => []),
    getStatus: vi.fn(),
    startService: vi.fn(),
    stopService: vi.fn(),
    restartService: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
  });
  return manager as unknown as ServiceManager;
}

describe("TasksView", () => {
  it("renders all tasks from config", () => {
    const config = makeConfig({
      migrate: { name: "Run migrations", commands: "pnpm db:migrate" },
      seed: { name: "Seed DB", commands: "pnpm db:seed" },
    });
    const manager = createMockManager();

    const { lastFrame } = render(
      <AppProvider manager={manager} config={config} paneMap={{}}>
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
    const manager = createMockManager();

    const { lastFrame } = render(
      <AppProvider manager={manager} config={config} paneMap={{}}>
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
    const manager = createMockManager();

    const { lastFrame } = render(
      <AppProvider manager={manager} config={config} paneMap={{}}>
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
    const manager = createMockManager();

    const { lastFrame } = render(
      <AppProvider manager={manager} config={config} paneMap={{}}>
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
    const manager = createMockManager();

    const { lastFrame } = render(
      <AppProvider manager={manager} config={config} paneMap={{}}>
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
