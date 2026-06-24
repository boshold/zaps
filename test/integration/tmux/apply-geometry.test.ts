import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LayoutNode } from "#src/config/types.js";
import { getEnv } from "#src/lib/env.js";
import type { Rect } from "#src/lib/tmux-layout.js";
import { computeRects } from "#src/lib/tmux-layout.js";
import type { PaneMap } from "#src/lib/tmux-reflow.js";
import { LayoutReflow } from "#src/lib/tmux-reflow.js";
import {
  capturePane,
  getWindowSize,
  paneIndexOrder,
  sendKeys,
  splitPane,
  windowLayout,
} from "#src/lib/tmux.js";

import { hasScriptPty, hasTmux, isCI } from "../helpers/skip.js";
import type { AttachedClient, TestSession } from "../helpers/tmux.js";
import { attachClient, createTestSession } from "../helpers/tmux.js";

const execFileAsync = promisify(execFile);

interface PaneGeom {
  id: string;
  pid: number;
  rect: Rect;
}

function tmuxSocketArgs(): string[] {
  const socket = getEnv("ZAPS_TMUX_SOCKET");
  return socket ? ["-L", socket] : [];
}

/** Read every pane's id, pid, and absolute geometry in spatial (pane_index) order. */
async function listPaneGeoms(target: string): Promise<PaneGeom[]> {
  const { stdout } = await execFileAsync("tmux", [
    ...tmuxSocketArgs(),
    "list-panes",
    "-t",
    target,
    "-F",
    "#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}",
  ]);
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [indexStr, id, pidStr, leftStr, topStr, widthStr, heightStr] = line.split("\t");
      return {
        index: Number.parseInt(indexStr, 10),
        id,
        pid: Number.parseInt(pidStr, 10),
        rect: {
          x: Number.parseInt(leftStr, 10),
          y: Number.parseInt(topStr, 10),
          width: Number.parseInt(widthStr, 10),
          height: Number.parseInt(heightStr, 10),
        },
      };
    })
    .toSorted((a, b) => a.index - b.index)
    .map(({ id, pid, rect }) => ({ id, pid, rect }));
}

/** Poll until `predicate(geoms)` is true or `timeoutMs` elapses. */
async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 3000,
  pollMs = 50,
): Promise<T> {
  const start = Date.now();
  /* eslint-disable no-await-in-loop -- polling */
  let value = await read();
  while (!predicate(value) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    value = await read();
  }
  /* eslint-enable no-await-in-loop */
  return value;
}

/** Build a column-split 3-pane window: left=initial, middle, right. */
async function buildThreeColumnWindow(session: TestSession): Promise<{
  paneMap: PaneMap;
  ids: { left: string; middle: string; right: string };
}> {
  // Split-after produces panes in spatial DFS order: [initial, middle, right].
  const middle = await splitPane(session.initialPaneId, "h");
  const right = await splitPane(middle, "h");
  await waitFor(
    async () => listPaneGeoms(session.name),
    (panes) => panes.length === 3,
  );
  return {
    paneMap: { "@tui": session.initialPaneId, api: middle, web: right },
    ids: { left: session.initialPaneId, middle, right },
  };
}

/** Run `stty size` in `paneId` and parse the captured `rows cols` line. */
async function probeStty(paneId: string): Promise<{ rows: number; cols: number }> {
  await sendKeys(paneId, "stty size");
  // Wait for shell to render the output (poll capture-pane).
  const found = await waitFor(
    async () => capturePane(paneId, 20),
    (out) => /^\d+\s+\d+$/m.test(out),
  );
  // Take the LAST match — earlier runs may have left other matches in the buffer.
  const matches = found.match(/^\d+\s+\d+$/gm) ?? [];
  const last = matches.at(-1) ?? "";
  const [rows, cols] = last.split(/\s+/).map((n) => Number.parseInt(n, 10));
  return { rows, cols };
}

function makeReflow(layout: LayoutNode, paneMap: PaneMap, sessionName: string): LayoutReflow {
  return new LayoutReflow({
    getLayout: () => layout,
    getPaneMap: () => paneMap,
    getWindowTarget: () => sessionName,
  });
}

describe.skipIf(!hasTmux())("LayoutReflow.applyGeometry — real tmux", () => {
  let session: TestSession;

  beforeEach(async () => {
    session = await createTestSession();
  });

  afterEach(async () => {
    await session.cleanup();
  });

  it("snaps a 3-column window to the EXACT computed rects and preserves every pane_pid", async () => {
    const { paneMap } = await buildThreeColumnWindow(session);
    const before = await listPaneGeoms(session.name);
    expect(before).toHaveLength(3);
    const pidsBefore = before.map((p) => p.pid);

    // Layout where @tui = 30%, api = 40%, web = 30% — geometrically different
    // From the equal-thirds tmux gives by default.
    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "30%" },
        { pane: "api", size: "40%" },
        { pane: "web", size: "30%" },
      ],
    };
    const reflow = makeReflow(layout, paneMap, session.name);

    await reflow.applyGeometry(new Set(["@tui", "api", "web"]));

    // Tmux applies select-layout synchronously, but kernel pty winsize delivery
    // Is asynchronous; poll until the geometry settles.
    const { width, height } = await getWindowSize(session.name);
    const expected = computeRects(layout, width, height);
    const after = await waitFor(
      async () => listPaneGeoms(session.name),
      (panes) =>
        panes.length === 3 &&
        panes[0].rect.width === (expected.get("@tui")?.width ?? -1) &&
        panes[1].rect.width === (expected.get("api")?.width ?? -1) &&
        panes[2].rect.width === (expected.get("web")?.width ?? -1),
    );

    // (1) EXACT geometry per pane.
    expect(after[0].rect).toEqual(expected.get("@tui"));
    expect(after[1].rect).toEqual(expected.get("api"));
    expect(after[2].rect).toEqual(expected.get("web"));

    // (2) No process restart — every pid preserved.
    const pidsAfter = after.map((p) => p.pid);
    expect(pidsAfter).toEqual(pidsBefore);
  });

  it("reorders panes via swap-pane to match the target DFS order; pids preserved", async () => {
    // Build [initial, middle, right] spatially.
    const { paneMap, ids } = await buildThreeColumnWindow(session);
    const before = await listPaneGeoms(session.name);
    const pidByName: Record<string, number> = {
      "@tui": before.find((p) => p.id === ids.left)!.pid,
      api: before.find((p) => p.id === ids.middle)!.pid,
      web: before.find((p) => p.id === ids.right)!.pid,
    };

    // Target order: [web, @tui, api] — a 3-cycle of the spatial order, can NOT
    // Be reached by an adjacency split; the reflow's fallback path takes over.
    const layout: LayoutNode = {
      direction: "columns",
      children: [{ pane: "web" }, { pane: "@tui" }, { pane: "api" }],
    };
    const reflow = makeReflow(layout, paneMap, session.name);

    await reflow.applyGeometry(new Set(["@tui", "api", "web"]));

    // (3) Spatial order now equals target DFS order.
    const targetIds = [ids.right, ids.left, ids.middle];
    const order = await waitFor(
      async () => paneIndexOrder(session.name),
      (entries) => entries.map((e) => e.id).join(",") === targetIds.join(","),
    );
    expect(order.map((e) => e.id)).toEqual(targetIds);

    // AC (3): Pids preserved across the swap — each name still maps to its original pid.
    const after = await listPaneGeoms(session.name);
    const livePidById = new Map(after.map((p) => [p.id, p.pid]));
    expect(livePidById.get(ids.left)).toBe(pidByName["@tui"]);
    expect(livePidById.get(ids.middle)).toBe(pidByName.api);
    expect(livePidById.get(ids.right)).toBe(pidByName.web);
  });

  it("delivers correct in-pane pty winsize after select-layout (detached server)", async () => {
    const { paneMap } = await buildThreeColumnWindow(session);

    // Resize to a deliberately uneven geometry so the per-pane size CHANGES.
    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "20%" },
        { pane: "api", size: "60%" },
        { pane: "web", size: "20%" },
      ],
    };
    const reflow = makeReflow(layout, paneMap, session.name);
    await reflow.applyGeometry(new Set(["@tui", "api", "web"]));

    // Tmux's `pane_width`/`pane_height` is what tmux *thinks* the pane is. The
    // Assertion below probes what the SHELL inside the pane actually perceives —
    // The kernel pty winsize that select-layout pushed.
    const { width: winW, height: winH } = await getWindowSize(session.name);
    const expected = computeRects(layout, winW, winH);

    const apiRect = expected.get("api");
    expect(apiRect).toBeDefined();
    if (!apiRect) {
      return;
    }
    const probed = await probeStty(paneMap.api);
    // (4) shell `stty size` reports the new geometry (no SIGWINCH staleness).
    expect(probed).toEqual({ rows: apiRect.height, cols: apiRect.width });
  });

  it("round-trips through windowLayout — the emitted layout string is what tmux now reports", async () => {
    const { paneMap } = await buildThreeColumnWindow(session);

    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "25%" },
        { pane: "api", size: "50%" },
        { pane: "web", size: "25%" },
      ],
    };
    const reflow = makeReflow(layout, paneMap, session.name);
    await reflow.applyGeometry(new Set(["@tui", "api", "web"]));

    // AC (5): Parse the live #{window_layout} and assert pane geometries match
    // The computed rects exactly — guards checksum/format on CI tmux (~3.4)
    // Against local tmux next-3.7.
    const live = await windowLayout(session.name);
    expect(live).toMatch(/^[0-9a-f]{4},\d+x\d+,/u);

    const { width, height } = await getWindowSize(session.name);
    const expected = computeRects(layout, width, height);
    // Leaves are `WxH,X,Y,<paneNumber>` and the pane number is followed by
    // Structural punctuation (`,` / `}` / `]`) — never another digit-x pair, so
    // The lookahead disambiguates leaves from the root rect's `WxH,X,Y{...`.
    const leafRe = /(?<w>\d+)x(?<h>\d+),(?<x>\d+),(?<y>\d+),(?<pn>\d+)(?=[,\]}])/gu;
    const leaves: { w: number; h: number; x: number; y: number }[] = [];
    for (const match of live.matchAll(leafRe)) {
      const groups = match.groups ?? { w: "0", h: "0", x: "0", y: "0" };
      leaves.push({
        w: Number.parseInt(groups.w, 10),
        h: Number.parseInt(groups.h, 10),
        x: Number.parseInt(groups.x, 10),
        y: Number.parseInt(groups.y, 10),
      });
    }
    const dfsRects = leaves;
    const expectedOrder = ["@tui", "api", "web"].map((name) => expected.get(name));
    for (const [i, expectedRect] of expectedOrder.entries()) {
      expect(expectedRect).toBeDefined();
      expect(dfsRects[i]).toEqual({
        w: expectedRect?.width,
        h: expectedRect?.height,
        x: expectedRect?.x,
        y: expectedRect?.y,
      });
    }
  });
});

// AC (4) attached-client variant — only runs locally with a real pty. CI runners
// Only fake one via `script`; their interactive guarantees are too weak for
// SIGWINCH timing here. Hermetic coverage is the detached probe above.
const canRunAttached = hasTmux() && hasScriptPty() && !isCI;

describe.skipIf(!canRunAttached)("LayoutReflow.applyGeometry — attached client", () => {
  let session: TestSession;
  let client: AttachedClient;

  beforeEach(async () => {
    session = await createTestSession();
    client = await attachClient(session.name);
  });

  afterEach(async () => {
    client.cleanup();
    await session.cleanup();
  });

  it("delivers correct in-pane pty winsize after select-layout (attached pty)", async () => {
    const { paneMap } = await buildThreeColumnWindow(session);

    const layout: LayoutNode = {
      direction: "columns",
      children: [
        { pane: "@tui", size: "20%" },
        { pane: "api", size: "60%" },
        { pane: "web", size: "20%" },
      ],
    };
    const reflow = makeReflow(layout, paneMap, session.name);
    await reflow.applyGeometry(new Set(["@tui", "api", "web"]));

    const { width: winW, height: winH } = await getWindowSize(session.name);
    const expected = computeRects(layout, winW, winH);
    const apiRect = expected.get("api");
    expect(apiRect).toBeDefined();
    if (!apiRect) {
      return;
    }
    const probed = await probeStty(paneMap.api);
    // If this assertion ever fails on a real attached terminal, that's the
    // Round-3 staleness edge — re-run with `{ resyncFallback: true }` and the
    // P02-T02 hook will resync the pty winsize.
    expect(probed).toEqual({ rows: apiRect.height, cols: apiRect.width });
  });
});
