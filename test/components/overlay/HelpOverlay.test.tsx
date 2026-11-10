import { render } from "ink-testing-library";
import { act, useEffect } from "react";
import { describe, expect, it } from "vitest";

import { DaemonClient } from "../../../src/client/daemon-client.js";
import { createBusyServices } from "../../../src/components/dashboard/busyServices.js";
import { helpKeymap } from "../../../src/components/hintText.js";
import { HELP_OVERLAY_ID, HelpOverlay } from "../../../src/components/overlay/HelpOverlay.js";
import { OverlayHost } from "../../../src/components/overlay/OverlayHost.js";
import type { ProjectedServiceStatus } from "../../../src/daemon/session.js";
import type { OverlayApi } from "../../../src/hooks/useOverlay.js";
import { OverlayProvider, useOverlay } from "../../../src/hooks/useOverlay.js";
import { AppProvider } from "../../../src/hooks/useZaps.js";
import { unavailableActions, unavailableCapabilities } from "../../../src/lib/backend/wire.js";
import {
  fullCapabilities,
  liveActions,
  mixedCapabilities,
} from "../../_helpers/ui-capabilities.js";

// HelpOverlay renders position="absolute" (uncapturable), so behavior is
// Asserted via the overlay stack rather than frame text.

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
};

// Send a key inside act + settle, so the pushed overlay's `useInput`
// Subscription (registered a commit after the push) reliably receives it.
async function press(stdin: { write: (data: string) => void }, data: string) {
  await act(async () => {
    stdin.write(data);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

let overlay: OverlayApi | undefined;
const busyServices = createBusyServices();

function Probe() {
  overlay = useOverlay();
  return null;
}

function HelpHarness() {
  const api = useOverlay();
  useEffect(() => {
    api.push({ id: HELP_OVERLAY_ID, render: () => <HelpOverlay busyServices={busyServices} /> });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only push
  }, []);
  return <OverlayHost />;
}

function renderHelp() {
  return render(
    <AppProvider
      client={new DaemonClient("/unused", "test")}
      paneMap={{}}
      projectName="test"
      tasks={[]}
      servicesMeta={[]}
    >
      <OverlayProvider>
        <Probe />
        <HelpHarness />
      </OverlayProvider>
    </AppProvider>,
  );
}

describe("HelpOverlay", () => {
  it("closes on a `?` press (toggle)", async () => {
    const { stdin } = renderHelp();
    await flush();
    expect(overlay?.isOpen).toBe(true);
    // Warm up the mock stdin pipeline with an ignored key (the overlay only
    // Acts on `?`), so the decisive keystroke isn't the dropped-first one.
    await press(stdin, "x");
    expect(overlay?.isOpen).toBe(true);
    await press(stdin, "?");
    expect(overlay?.isOpen).toBe(false);
  });

  it("closes on Esc via OverlayHost (not bound by the overlay itself)", async () => {
    const { stdin } = renderHelp();
    await flush();
    await press(stdin, "x"); // Warm-up (ignored); Esc handler lives on OverlayHost
    await press(stdin, "\x1B"); // Esc
    expect(overlay?.isOpen).toBe(false);
  });
});

const service: ProjectedServiceStatus = {
  name: "web",
  state: "stopped",
  ports: [],
  retryCount: 0,
  isDocker: true,
  url: "http://localhost:3000",
  actions: liveActions,
};

describe("helpKeymap", () => {
  it("documents the global, dashboard, and palette groups", () => {
    const keymap = helpKeymap(unavailableCapabilities, undefined);
    const titles = keymap.map((g) => g.title);
    expect(titles).toContain("Global");
    expect(titles).toContain("Dashboard");
    expect(keymap.some((g) => g.rows.some(([keys]) => keys.includes("Ctrl-K")))).toBe(true);
  });
});

describe("conditional help rows", () => {
  it.each([
    [unavailableCapabilities, ["r", "s", "l", "o", "R", "t"]],
    [mixedCapabilities, ["r", "s", "l", "o", "R", "t", "Tab"]],
    [fullCapabilities, ["r", "s", "l", "o", "R", "t", "Tab", "z", "Z", "E"]],
  ])("matches %j", (capabilities, expected) => {
    const keys = helpKeymap(capabilities, service).flatMap(({ rows }) => rows.map(([key]) => key));
    const conditional = new Set(["r", "s", "l", "o", "R", "t", "Tab", "z", "Z", "E"]);
    expect(new Set(keys.filter((key) => conditional.has(key)))).toEqual(new Set(expected));
  });

  it("keeps dashboard zoom when the selected pane disappears", () => {
    const keys = helpKeymap(fullCapabilities, {
      ...service,
      actions: unavailableActions,
      group: "",
    }).flatMap(({ rows }) => rows.map(([key]) => key));
    expect(keys).toContain("Z");
    expect(keys).not.toContain("z");
    expect(keys).not.toContain("E");
    expect(keys).not.toContain("R");
  });
});
