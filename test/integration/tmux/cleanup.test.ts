import { killPane, listPanes, removeEnv, setEnv, showEnv, splitPane } from "#src/lib/tmux.js";
import type { TestSession } from "../helpers/tmux.js";
import { afterEach, describe, expect, it } from "vitest";

import { hasTmux } from "../helpers/skip.js";
import { createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("tmux cleanup integration", () => {
  let session: TestSession;

  afterEach(async () => {
    await session.cleanup();
  });

  it("killPane removes spawned pane", async () => {
    session = await createTestSession();
    const pane1 = await splitPane(session.initialPaneId, "v");
    const pane2 = await splitPane(session.initialPaneId, "v");

    const before = await listPanes(session.name);
    expect(before).toHaveLength(3);

    await killPane(pane1);
    await killPane(pane2);

    const after = await listPanes(session.name);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(session.initialPaneId);
  });

  it("cleanup preserves origin pane", async () => {
    session = await createTestSession();
    const pane1 = await splitPane(session.initialPaneId, "v");
    const pane2 = await splitPane(session.initialPaneId, "h");

    // Kill non-origin panes
    await killPane(pane1);
    await killPane(pane2);

    const panes = await listPanes(session.name);
    expect(panes).toHaveLength(1);
    expect(panes[0].id).toBe(session.initialPaneId);
  });

  it("env cleanup on down", async () => {
    session = await createTestSession();
    const envKeys = ["ZAPS_PANE_MAP", "ZAPS_ORIGIN_PANE", "ZAPS_INVOKE_DIR"];

    // Set all env vars
    for (const key of envKeys) {
      await setEnv(session.name, key, "test-value");
    }

    // Verify they're set
    for (const key of envKeys) {
      const val = await showEnv(session.name, key);
      expect(val).toBe("test-value");
    }

    // Remove all (simulating down command)
    for (const key of envKeys) {
      await removeEnv(session.name, key);
    }

    // Verify cleared
    for (const key of envKeys) {
      const val = await showEnv(session.name, key);
      expect(val).toBeNull();
    }
  });
});
