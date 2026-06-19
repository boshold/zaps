import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

// Pin a short 21-row pane — the size class where the v1 chromeRows arithmetic
// Overflowed once a task ran or a service errored, drifting the alt-screen
// Cursor and blanking the pane.
const fakeStdout = vi.hoisted(() => ({
  columns: 100,
  rows: 21,
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

const { Dashboard } = await import("../../src/components/Dashboard.js");
const { AppProvider } = await import("../../src/hooks/useZaps.js");
type DaemonClient = import("../../src/client/daemon-client.js").DaemonClient;
type ServiceStatus = import("../../src/lib/service/types.js").ServiceStatus;
type TaskRunRecord = import("../../src/components/TaskRunRecord.js").TaskRunRecord;

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
      tasks: [],
      servicesMeta: [],
    }),
    destroySession: vi.fn().mockResolvedValue(undefined),
    listServices: vi.fn().mockResolvedValue([]),
    runTask: vi.fn().mockResolvedValue({ success: true }),
  });
  return client as unknown as DaemonClient;
}

function makeStatus(
  name: string,
  state: ServiceStatus["state"] = "ready",
  extra: Partial<ServiceStatus> = {},
): ServiceStatus {
  return { name, state, ports: [], retryCount: 0, ...extra };
}

describe("Dashboard overflow (v1 blank repro)", () => {
  it("never exceeds the pane height with history + an errored service at 21 rows", () => {
    // The exact repro: many services, one errored (adds an error sub-row), and a
    // Populated task history (adds the Recent Tasks block).
    const statuses: ServiceStatus[] = [
      makeStatus("db", "error", { lastError: "exited 1" }),
      ...Array.from({ length: 15 }, (_, i) => makeStatus(`svc-${String(i)}`)),
    ];
    const taskHistory: TaskRunRecord[] = [
      { runId: "a", taskKey: "a", taskName: "Migrate", result: "success", timestamp: 1 },
      { runId: "b", taskKey: "b", taskName: "Build", result: "error", timestamp: 2 },
      { runId: "c", taskKey: "c", taskName: "Seed", result: "success", timestamp: 3 },
    ];

    const { lastFrame } = render(
      <AppProvider
        client={createMockClient()}
        paneMap={{}}
        projectName="repro"
        tasks={[]}
        servicesMeta={[]}
      >
        <Dashboard statuses={statuses} selectedIndex={0} taskHistory={taskHistory} />
      </AppProvider>,
    );

    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");

    // Fits the pane — no overflow that would drift the alt-screen cursor.
    expect(lines.length).toBeLessThanOrEqual(21);
    // Not blank — the v1 symptom was an empty pane.
    expect(frame.trim()).not.toBe("");
    // Chrome + content are actually visible.
    expect(frame).toContain("repro");
    expect(frame).toContain("Recent Tasks");
    expect(frame).toContain("[t]asks");
  });
});
