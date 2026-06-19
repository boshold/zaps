import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { useInputRouter } from "../../src/hooks/useInputRouter.js";
import type { InputRouterFlags } from "../../src/hooks/useInputRouter.js";
import type { OverlayApi } from "../../src/hooks/useOverlay.js";
import { OverlayProvider, useOverlay } from "../../src/hooks/useOverlay.js";
import type { View } from "../../src/hooks/useRouter.js";

let flags: InputRouterFlags | undefined;
let overlay: OverlayApi | undefined;

function Probe({ view, ready, connected }: { view: View; ready: boolean; connected: boolean }) {
  flags = useInputRouter(view, { ready, connected });
  overlay = useOverlay();
  return <Text>ok</Text>;
}

function renderRouterFlags(view: View, ready = true, connected = true) {
  return render(
    <OverlayProvider>
      <Probe view={view} ready={ready} connected={connected} />
    </OverlayProvider>,
  );
}

describe("useInputRouter", () => {
  it("activates only the current base view when ready, connected, and no overlay", () => {
    renderRouterFlags("dashboard");
    expect(flags).toMatchObject({
      overlayOpen: false,
      global: true,
      dashboard: true,
      logs: false,
      tasks: false,
      dockerRebuild: false,
    });
  });

  it("routes to the log view when that view is current", () => {
    renderRouterFlags("logs");
    expect(flags?.logs).toBe(true);
    expect(flags?.dashboard).toBe(false);
  });

  it("makes every consumer inert during the splash (not ready)", () => {
    renderRouterFlags("dashboard", false);
    expect(flags?.global).toBe(false);
    expect(flags?.dashboard).toBe(false);
  });

  it("keeps global keys live but freezes base views while disconnected", () => {
    renderRouterFlags("dashboard", true, false);
    // `q`/`r` (global) must still work when offline; base views must not.
    expect(flags?.global).toBe(true);
    expect(flags?.dashboard).toBe(false);
  });

  it("makes base views and global keys inert while an overlay is open", () => {
    renderRouterFlags("dashboard");
    expect(flags?.dashboard).toBe(true);

    act(() => overlay?.push({ id: "x", render: () => null }));
    expect(flags?.overlayOpen).toBe(true);
    expect(flags?.dashboard).toBe(false);
    expect(flags?.logs).toBe(false);
    expect(flags?.tasks).toBe(false);
    expect(flags?.dockerRebuild).toBe(false);
    // Global yields to the overlay so the palette can own typed keys (e.g. `q`).
    expect(flags?.global).toBe(false);

    act(() => overlay?.pop());
    expect(flags?.overlayOpen).toBe(false);
    expect(flags?.dashboard).toBe(true);
  });
});
