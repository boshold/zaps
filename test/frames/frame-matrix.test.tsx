import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// One mutable fake stdout drives `useDimensions` for every render; each case sets
// Its rows/cols before rendering. Mocking ink's `useStdout` (not ink-testing-
// Library's capture stream) is the established size-control pattern (see
// Dashboard.overflow.test). Height is governed by `useDimensions().rows` +
// FullscreenLayout's `height={rows}` + `overflowY="hidden"` clip — the exact
// Invariant these tests lock in.
const fakeStdout = {
  columns: 100,
  rows: 24,
  on() {
    /* No resize events in tests. */
  },
  off() {
    /* No resize events in tests. */
  },
};

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return { ...actual, useStdout: () => ({ stdout: fakeStdout }) };
});

const { Dashboard } = await import("../../src/components/Dashboard.js");
const { LogView } = await import("../../src/components/LogView.js");
const { DisconnectBanner } = await import("../../src/components/DisconnectBanner.js");
const { CommandPaletteBody } = await import("../../src/components/overlay/CommandPaletteBody.js");
const { TaskPickerBody } = await import("../../src/components/overlay/TaskPickerBody.js");
const { FailedOutputBody } = await import("../../src/components/overlay/FailedOutputBody.js");
const { ToastList } = await import("../../src/components/toast/ToastList.js");
const { AppProvider } = await import("../../src/hooks/useZaps.js");
const { resolveUiConfig } = await import("../../src/config/index.js");

type DaemonClient = import("../../src/client/daemon-client.js").DaemonClient;
type ServiceStatus = import("../../src/lib/service/types.js").ServiceStatus;
type TaskRunRecord = import("../../src/components/TaskRunRecord.js").TaskRunRecord;
type TaskInfo = import("../../src/daemon/session.js").TaskInfo;
type Command = import("../../src/lib/command-registry.js").Command;
type ResolvedUiConfig = import("../../src/config/index.js").ResolvedUiConfig;

function setSize(rows: number, cols: number): void {
  fakeStdout.rows = rows;
  fakeStdout.columns = cols;
}

function mockClient(): DaemonClient {
  return new EventEmitter() as unknown as DaemonClient;
}

function makeStatus(
  name: string,
  state: ServiceStatus["state"] = "ready",
  extra: Partial<ServiceStatus> = {},
): ServiceStatus {
  return { name, state, ports: [], retryCount: 0, ...extra };
}

// Every service state + variant, so list/row/detail branches are all exercised.
const POPULATED: ServiceStatus[] = [
  makeStatus("api", "ready", {
    url: "http://localhost:3000",
    ports: [3000],
    pid: 1234,
    readySince: 1,
  }),
  makeStatus("web", "starting"),
  makeStatus("worker", "stopped"),
  makeStatus("restarter", "restarting"),
  makeStatus("stopper", "stopping"),
  makeStatus("cache", "ready", { isDocker: true, group: "infra" }),
  makeStatus("queue", "ready", { isDetached: true }),
  makeStatus("db", "error", { lastError: "exited 1", retryCount: 2 }),
  makeStatus("legacy", "unavailable"),
  ...Array.from({ length: 8 }, (_, i) => makeStatus(`svc-${String(i)}`)),
];

const HISTORY: TaskRunRecord[] = [
  { runId: "a", taskKey: "migrate", taskName: "Migrate", result: "success", timestamp: 1 },
  { runId: "b", taskKey: "build", taskName: "Build", result: "error", timestamp: 2 },
  { runId: "c", taskKey: "seed", taskName: "Seed", result: "running", timestamp: 3 },
];

const TASKS: TaskInfo[] = [
  { key: "migrate", name: "Migrate DB", description: "Run migrations", shortcut: "m" },
  { key: "build", name: "Build app", description: null },
  { key: "seed", name: "Seed database", description: "Insert fixtures" },
];

const COMMANDS: Command[] = [
  { id: "restart", title: "Restart api", group: "context", run: () => undefined },
  { id: "all", title: "Restart all services", group: "global", run: () => undefined },
  {
    id: "url",
    title: "Open url",
    group: "context",
    hint: "http://localhost:3000",
    run: () => undefined,
  },
];

const LOG_LINES = Array.from({ length: 200 }, (_, i) => `log line ${String(i)} — some output text`);

// Sizes from a tiny 20×40 pane to a large screen, plus compact (<12 rows) and a
// Narrow (<50 cols) case to exercise the responsive branches.
const SIZES = [
  { rows: 11, cols: 60 }, // Compact (< 12 rows)
  { rows: 20, cols: 40 }, // Tiny + narrow (< 50 cols)
  { rows: 21, cols: 100 }, // V1 repro height
  { rows: 24, cols: 80 },
  { rows: 30, cols: 120 }, // Wide → detail pane
  { rows: 40, cols: 160 },
  { rows: 50, cols: 200 },
];

function renderInApp(node: ReactNode, ui?: ResolvedUiConfig) {
  return render(
    <AppProvider
      client={mockClient()}
      paneMap={{}}
      projectName="zaps-frames"
      tasks={[]}
      servicesMeta={[]}
      ui={ui}
    >
      {node}
    </AppProvider>,
  );
}

function fits(frame: string, rows: number): void {
  const lines = frame.split("\n");
  // No overflow: the rendered region never exceeds the pane height.
  expect(lines.length).toBeLessThanOrEqual(rows);
}

function nonBlank(frame: string): void {
  expect(frame.trim().length).toBeGreaterThan(0);
}

describe.each(SIZES)("dashboard frames @ $rows×$cols", ({ rows, cols }) => {
  it("empty dashboard fits and is non-blank", () => {
    setSize(rows, cols);
    const { lastFrame } = renderInApp(
      <Dashboard statuses={[]} selectedIndex={0} taskHistory={[]} />,
    );
    const frame = lastFrame() ?? "";
    fits(frame, rows);
    nonBlank(frame);
    expect(frame).toContain("zaps-frames");
  });

  it("populated dashboard (all states + history) fits and is non-blank", () => {
    setSize(rows, cols);
    const { lastFrame } = renderInApp(
      <Dashboard statuses={POPULATED} selectedIndex={5} taskHistory={HISTORY} />,
    );
    const frame = lastFrame() ?? "";
    fits(frame, rows);
    nonBlank(frame);
  });

  it("disconnected dashboard (banner) fits and is non-blank", () => {
    setSize(rows, cols);
    const { lastFrame } = renderInApp(
      <Dashboard
        statuses={POPULATED}
        selectedIndex={0}
        taskHistory={HISTORY}
        banner={<DisconnectBanner />}
      />,
    );
    const frame = lastFrame() ?? "";
    fits(frame, rows);
    nonBlank(frame);
  });

  it("log view (200 lines) fits and is non-blank", () => {
    setSize(rows, cols);
    const { lastFrame } = renderInApp(
      <LogView serviceName="api" lines={LOG_LINES} autoScroll offset={0} />,
    );
    const frame = lastFrame() ?? "";
    fits(frame, rows);
    nonBlank(frame);
  });
});

describe("v1 blank/overflow repro", () => {
  it("populated history + errored service at 21 rows never overflows or blanks", () => {
    setSize(21, 100);
    const statuses: ServiceStatus[] = [
      makeStatus("db", "error", { lastError: "exited 1" }),
      ...Array.from({ length: 15 }, (_, i) => makeStatus(`svc-${String(i)}`)),
    ];
    const { lastFrame } = renderInApp(
      <Dashboard statuses={statuses} selectedIndex={0} taskHistory={HISTORY} />,
    );
    const frame = lastFrame() ?? "";
    fits(frame, 21);
    nonBlank(frame);
    expect(frame).toContain("Recent Tasks");
    expect(frame).toContain("[t]asks");
  });
});

describe("detail pane wideThreshold boundary", () => {
  // Pin wideThreshold to the MIN_WIDE_COLS floor (81) so the boundary is testable
  // Without a 100-col pane; below it the split cannot fit and must collapse.
  const ui = resolveUiConfig({ wideThreshold: 81 });

  it("collapses the detail pane below the threshold without overflow", () => {
    setSize(30, 80);
    const { lastFrame } = renderInApp(
      <Dashboard statuses={POPULATED} selectedIndex={0} taskHistory={HISTORY} />,
      ui,
    );
    const frame = lastFrame() ?? "";
    fits(frame, 30);
    nonBlank(frame);
    // Detail-only field labels are absent when collapsed.
    expect(frame).not.toContain("uptime");
  });

  it("shows the detail pane at/above the threshold without overflow", () => {
    setSize(30, 120);
    const { lastFrame } = renderInApp(
      <Dashboard statuses={POPULATED} selectedIndex={0} taskHistory={HISTORY} />,
      ui,
    );
    const frame = lastFrame() ?? "";
    fits(frame, 30);
    nonBlank(frame);
    // The detail pane renders its field labels for the selected service.
    expect(frame).toContain("uptime");
    expect(frame).toContain("retries");
  });

  it("draws a vertical divider column beside the detail pane", () => {
    // The themed tree-branch glyph (│) is prefixed to every detail line, so the
    // Wide frame carries many more bars than the collapsed one (which has at most
    // The errored service's sub-row). Distinguishes the divider from incidental
    // Glyphs without depending on an exact count.
    setSize(30, 120);
    const wide = renderInApp(
      <Dashboard statuses={POPULATED} selectedIndex={0} taskHistory={HISTORY} />,
      ui,
    ).lastFrame();
    setSize(30, 80);
    const narrow = renderInApp(
      <Dashboard statuses={POPULATED} selectedIndex={0} taskHistory={HISTORY} />,
      ui,
    ).lastFrame();
    const bars = (s: string | undefined) => (s?.match(/│/g) ?? []).length;
    expect(bars(wide)).toBeGreaterThanOrEqual(5);
    expect(bars(wide)).toBeGreaterThan(bars(narrow));
  });
});

describe("footer rules", () => {
  it("brackets the footer chrome with full-width rules when not compact", () => {
    setSize(30, 120);
    const { lastFrame } = renderInApp(
      <Dashboard statuses={POPULATED} selectedIndex={0} taskHistory={HISTORY} />,
    );
    const frame = lastFrame() ?? "";
    fits(frame, 30);
    // Header rule (┬ junction) + a rule under the body (┴ junction) = >= 2 lines
    // Made of the divider glyph and the pane-frame tee junctions. (In split mode
    // Recent Tasks lives in the left column, not the footer, so its rule is no
    // Longer a full-width line.)
    const ruleLines = frame.split("\n").filter((l) => /^[─┬┴]+$/.test(l.trim()));
    expect(ruleLines.length).toBeGreaterThanOrEqual(2);
  });

  it("omits the footer rules in compact mode", () => {
    setSize(11, 60);
    const { lastFrame } = renderInApp(
      <Dashboard statuses={POPULATED} selectedIndex={0} taskHistory={HISTORY} />,
    );
    const frame = lastFrame() ?? "";
    fits(frame, 11);
    const ruleLines = frame.split("\n").filter((l) => /^[─┬┴]+$/.test(l.trim()));
    // Compact hides the header rule and the footer rules alike.
    expect(ruleLines.length).toBe(0);
  });
});

describe("overlay body frames", () => {
  it("command palette body fits and is non-blank", () => {
    setSize(24, 80);
    const { lastFrame } = render(
      <CommandPaletteBody commands={COMMANDS} isActive onClose={() => undefined} />,
    );
    const frame = lastFrame() ?? "";
    fits(frame, 24);
    nonBlank(frame);
    expect(frame).toContain("Restart all services");
  });

  it("task picker body (with a running task) fits and is non-blank", () => {
    setSize(24, 80);
    const { lastFrame } = render(
      <TaskPickerBody
        tasks={TASKS}
        runningKeys={new Set(["seed"])}
        defaultMode="background"
        isActive
        onClose={() => undefined}
        onRun={() => undefined}
      />,
    );
    const frame = lastFrame() ?? "";
    fits(frame, 24);
    nonBlank(frame);
    expect(frame).toContain("Migrate DB");
  });

  it("failed-output body renders fetched output and fits", () => {
    setSize(24, 80);
    const { lastFrame } = render(
      <FailedOutputBody
        taskName="Build"
        state="ready"
        lines={["compiling", "boom: failed", "exit 1"]}
        selectedIndex={2}
        maxHeight={10}
        canEscalate
      />,
    );
    const frame = lastFrame() ?? "";
    fits(frame, 24);
    nonBlank(frame);
    expect(frame).toContain("Failed: Build");
    expect(frame).toContain("boom: failed");
  });

  it("failed-output body shows the evicted message", () => {
    setSize(24, 80);
    const { lastFrame } = render(
      <FailedOutputBody
        taskName="Build"
        state="not_found"
        lines={[]}
        selectedIndex={0}
        maxHeight={10}
        canEscalate={false}
      />,
    );
    const frame = lastFrame() ?? "";
    fits(frame, 24);
    expect(frame).toContain("no longer available");
  });

  it("toast list renders toasts + a sticky-failure badge and fits", () => {
    setSize(24, 80);
    const { lastFrame } = render(
      <ToastList
        toasts={[
          {
            id: "t1",
            level: "success",
            message: "Build succeeded",
            runId: null,
            sticky: false,
            createdAt: 0,
          },
          {
            id: "t2",
            level: "error",
            message: "Deploy failed",
            runId: "run_9",
            sticky: true,
            createdAt: 0,
          },
        ]}
        stickyTotal={1}
      />,
    );
    const frame = lastFrame() ?? "";
    fits(frame, 24);
    nonBlank(frame);
    expect(frame).toContain("Deploy failed");
    expect(frame).toContain("[f] view");
  });
});
