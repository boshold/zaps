import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../../src/client/daemon-client.js";
import { Dashboard } from "../../../src/components/Dashboard.js";
import type { TaskRunRecord } from "../../../src/components/TaskRunRecord.js";
import type { IconTier } from "../../../src/components/theme/icons.js";
import { IconThemeProvider, createIconTheme } from "../../../src/components/theme/IconTheme.js";
import type { ServiceMeta } from "../../../src/daemon/session.js";
import { AppProvider } from "../../../src/hooks/useZaps.js";
import type { ServiceStatus } from "../../../src/lib/service/types.js";

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
  { name: "api", state: "ready", ports: [3000], retryCount: 0 },
  { name: "db", state: "error", ports: [], retryCount: 0, lastError: "boom" },
  { name: "worker", state: "starting", ports: [], retryCount: 0 },
];

const HISTORY: TaskRunRecord[] = [
  { runId: "a", taskKey: "a", taskName: "Migrate", result: "success", timestamp: 1 },
  { runId: "b", taskKey: "b", taskName: "Build", result: "error", timestamp: 2 },
];

function renderDashboard(tier: IconTier, configStale = false) {
  return render(
    <IconThemeProvider value={createIconTheme(tier)}>
      <AppProvider
        client={createMockClient()}
        paneMap={{}}
        projectName="proj"
        tasks={[]}
        servicesMeta={STATUSES.map((s) => makeMeta(s.name))}
        configStale={configStale}
      >
        <Dashboard statuses={STATUSES} selectedIndex={1} taskHistory={HISTORY} />
      </AppProvider>
    </IconThemeProvider>,
  );
}

function isPureAscii(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 127) {
      return false;
    }
  }
  return true;
}

describe("glyphs by tier", () => {
  it("renders a fully 7-bit dashboard frame under the ascii tier", () => {
    // With configStale on, this also exercises the header's stale-config hint dash.
    const { lastFrame } = renderDashboard("ascii", true);
    const frame = lastFrame() ?? "";
    expect(frame.trim()).not.toBe("");
    expect(frame).toContain("config changed");
    // No mojibake anywhere: header logo, status glyphs, error branch, Recent
    // Tasks result icons, the divider, and the stale-config hint resolve to ascii.
    const offending: string[] = [];
    for (let i = 0; i < frame.length; i += 1) {
      if (frame.charCodeAt(i) > 127) {
        offending.push(frame[i]);
      }
    }
    expect(offending, `non-ascii chars: ${offending.join(" ")}`).toEqual([]);
    expect(isPureAscii(frame)).toBe(true);
  });

  it("uses nerd glyphs under the nerd tier (so switching tiers changes output)", () => {
    const { lastFrame } = renderDashboard("nerd");
    const frame = lastFrame() ?? "";
    // Nerd tier still uses the rich glyphs (ready / error / logo).
    expect(frame).toContain("●");
    expect(frame).toContain("✖");
    expect(frame).toContain("⚡");
  });

  it("changes the same glyph across tiers", () => {
    const ascii = renderDashboard("ascii").lastFrame() ?? "";
    const nerd = renderDashboard("nerd").lastFrame() ?? "";
    // Content identical, glyphs differ.
    expect(ascii).not.toBe(nerd);
    expect(ascii).toContain("Migrate");
    expect(nerd).toContain("Migrate");
  });
});
