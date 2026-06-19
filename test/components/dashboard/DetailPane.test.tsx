import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

// Mutable fake terminal so each test can set the column count the breakpoint reads.
const fakeStdout = vi.hoisted(() => ({
  columns: 130,
  rows: 30,
  on() {
    /* Empty */
  },
  off() {
    /* Empty */
  },
}));

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return { ...actual, useStdout: () => ({ stdout: fakeStdout }) };
});

const { Dashboard } = await import("../../../src/components/Dashboard.js");
const { AppProvider } = await import("../../../src/hooks/useZaps.js");
const { resolveUiConfig } = await import("../../../src/config/index.js");
type DaemonClient = import("../../../src/client/daemon-client.js").DaemonClient;
type ServiceMeta = import("../../../src/daemon/session.js").ServiceMeta;
type ServiceStatus = import("../../../src/lib/service/types.js").ServiceStatus;

function createMockClient(): DaemonClient {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
  }) as unknown as DaemonClient;
}

const makeMeta = (name: string): ServiceMeta =>
  ({
    name,
    dockerDefaults: {
      build: false,
      forceRecreate: false,
      renewVolumes: false,
      pull: false,
      removeOrphans: false,
    },
  }) as unknown as ServiceMeta;

const STATUSES: ServiceStatus[] = [
  { name: "api", state: "ready", ports: [3000], retryCount: 0, url: "http://localhost:3000" },
  { name: "db", state: "error", ports: [5432], retryCount: 2, lastError: "exited 1" },
];

function renderDashboard(selectedIndex = 0, wideThreshold?: number) {
  const ui = wideThreshold === undefined ? undefined : resolveUiConfig({ wideThreshold });
  return render(
    <AppProvider
      client={createMockClient()}
      paneMap={{}}
      projectName="proj"
      tasks={[]}
      servicesMeta={STATUSES.map((s) => makeMeta(s.name))}
      ui={ui}
    >
      <Dashboard statuses={STATUSES} selectedIndex={selectedIndex} taskHistory={[]} />
    </AppProvider>,
  );
}

function lineCount(frame: string): number {
  return frame.split("\n").length;
}

// The ink-testing-library render canvas is fixed at 100 cols, so the "wide"
// Cases use cols=100 (== the default wideThreshold) — the widest the harness
// Renders without the layout exceeding the real canvas.
describe("DetailPane (wide layout)", () => {
  it("shows the detail pane with the selected service at cols=100 (>= wideThreshold)", () => {
    fakeStdout.columns = 100;
    fakeStdout.rows = 30;
    const { lastFrame } = renderDashboard(0);
    const frame = lastFrame() ?? "";
    // Detail fields for the selected service.
    expect(frame).toContain("state:");
    expect(frame).toContain("uptime:");
    expect(frame).toContain("ports:");
    expect(frame).toContain("url:");
    expect(frame).toContain("http://localhost:3000");
    expect(lineCount(frame)).toBeLessThanOrEqual(30);
  });

  it("updates the pane when the selection changes", () => {
    fakeStdout.columns = 100;
    fakeStdout.rows = 30;
    const { lastFrame } = renderDashboard(1);
    const frame = lastFrame() ?? "";
    // The errored db service surfaces its lastError in the pane.
    expect(frame).toContain("exited 1");
    expect(frame).toContain("retries:");
  });

  it("hides the detail pane below the threshold (cols=80)", () => {
    fakeStdout.columns = 80;
    fakeStdout.rows = 30;
    const { lastFrame } = renderDashboard(0);
    const frame = lastFrame() ?? "";
    // No detail field labels; the list still renders the services.
    expect(frame).not.toContain("uptime:");
    expect(frame).not.toContain("retries:");
    expect(frame).toContain("api");
    expect(frame).toContain("db");
    expect(lineCount(frame)).toBeLessThanOrEqual(30);
  });

  it("does not overflow at the threshold boundary (cols=100)", () => {
    fakeStdout.columns = 100;
    fakeStdout.rows = 24;
    const { lastFrame } = renderDashboard(0);
    const frame = lastFrame() ?? "";
    expect(frame.trim()).not.toBe("");
    expect(lineCount(frame)).toBeLessThanOrEqual(24);
  });

  it("stays single-column when wideThreshold is below the min fittable width", () => {
    // Schema allows wideThreshold >= 40, but list(48)+detail(32)+gap(1)=81 can't
    // Fit at 60 cols — the layout must not enter wide mode and must not overflow.
    fakeStdout.columns = 60;
    fakeStdout.rows = 24;
    const { lastFrame } = renderDashboard(0, 40);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("uptime:");
    expect(frame).not.toContain("retries:");
    expect(frame).toContain("api");
    expect(lineCount(frame)).toBeLessThanOrEqual(24);
  });
});
