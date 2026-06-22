import { EventEmitter } from "node:events";

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { DaemonClient } from "../../src/client/daemon-client.js";
import { Dashboard } from "../../src/components/Dashboard.js";
import { DisconnectBanner } from "../../src/components/DisconnectBanner.js";
import type { ServiceMeta } from "../../src/daemon/session.js";
import { AppProvider } from "../../src/hooks/useZaps.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";

function createMockClient(): DaemonClient {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
  });
  return client as unknown as DaemonClient;
}

function renderDashboard(opts: {
  statuses: ServiceStatus[];
  servicesMeta?: ServiceMeta[];
  banner?: boolean;
}) {
  return render(
    <AppProvider
      client={createMockClient()}
      paneMap={{}}
      projectName="test-project"
      tasks={[]}
      servicesMeta={opts.servicesMeta ?? []}
    >
      <Dashboard
        statuses={opts.statuses}
        selectedIndex={0}
        taskHistory={[]}
        banner={opts.banner ? <DisconnectBanner /> : undefined}
      />
    </AppProvider>,
  );
}

const META: ServiceMeta = {
  name: "api",
  group: undefined,
  isDocker: false,
  dockerDefaults: {
    build: false,
    forceRecreate: false,
    renewVolumes: false,
    pull: false,
    removeOrphans: false,
  },
} as unknown as ServiceMeta;

describe("Dashboard empty / loading / disconnect states", () => {
  it("shows the no-services hint when nothing is configured", () => {
    const { lastFrame } = renderDashboard({ statuses: [], servicesMeta: [] });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No services configured");
    expect(frame.trim()).not.toBe("");
  });

  it("shows the loading placeholder when configured but nothing reported yet", () => {
    const { lastFrame } = renderDashboard({ statuses: [], servicesMeta: [META] });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Starting services");
    expect(frame).not.toContain("No services configured");
  });

  it("renders the disconnect banner over the last-known dashboard, non-blank", () => {
    const statuses: ServiceStatus[] = [{ name: "api", state: "ready", ports: [], retryCount: 0 }];
    const { lastFrame } = renderDashboard({ statuses, servicesMeta: [META], banner: true });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Daemon connection lost");
    expect(frame).toContain("r retry");
    // Last-known data is still visible behind the banner.
    expect(frame).toContain("api");
    expect(frame.trim()).not.toBe("");
    expect(frame.split("\n").length).toBeLessThanOrEqual(24);
  });
});
