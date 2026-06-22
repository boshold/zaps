import { render } from "ink-testing-library";
import { act, useEffect } from "react";
import { describe, expect, it } from "vitest";

import {
  HELP_OVERLAY_ID,
  HelpOverlay,
  KEYMAP,
} from "../../../src/components/overlay/HelpOverlay.js";
import { OverlayHost } from "../../../src/components/overlay/OverlayHost.js";
import type { OverlayApi } from "../../../src/hooks/useOverlay.js";
import { OverlayProvider, useOverlay } from "../../../src/hooks/useOverlay.js";

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

function Probe() {
  overlay = useOverlay();
  return null;
}

function HelpHarness() {
  const api = useOverlay();
  useEffect(() => {
    api.push({ id: HELP_OVERLAY_ID, render: () => <HelpOverlay /> });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only push
  }, []);
  return <OverlayHost />;
}

function renderHelp() {
  return render(
    <OverlayProvider>
      <Probe />
      <HelpHarness />
    </OverlayProvider>,
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

describe("KEYMAP", () => {
  it("documents the global, dashboard, and palette groups", () => {
    const titles = KEYMAP.map((g) => g.title);
    expect(titles).toContain("Global");
    expect(titles).toContain("Dashboard");
    expect(KEYMAP.some((g) => g.rows.some(([keys]) => keys.includes("Ctrl-K")))).toBe(true);
  });
});
