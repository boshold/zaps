import type { ServiceConfig } from "#src/config/types.js";
import { createLayout } from "#src/lib/tmux-layout.js";
import { removeEnv, setEnv, showEnv } from "#src/lib/tmux.js";
import type { TestSession } from "../helpers/tmux.js";
import { afterEach, describe, expect, it } from "vitest";

import { hasTmux } from "../helpers/skip.js";
import { createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("tmux pane-env integration", () => {
  let session: TestSession;

  afterEach(async () => {
    await session.cleanup();
  });

  it("setEnv + showEnv roundtrip", async () => {
    session = await createTestSession();
    const paneMap = { "@tui": session.initialPaneId, api: session.initialPaneId };
    const json = JSON.stringify(paneMap);

    await setEnv(session.name, "ZAPS_PANE_MAP", json);
    const result = await showEnv(session.name, "ZAPS_PANE_MAP");

    expect(result).toBe(json);
  });

  it("removeEnv clears variable", async () => {
    session = await createTestSession();

    await setEnv(session.name, "ZAPS_TEST_VAR", "hello");
    const before = await showEnv(session.name, "ZAPS_TEST_VAR");
    expect(before).toBe("hello");

    await removeEnv(session.name, "ZAPS_TEST_VAR");
    const after = await showEnv(session.name, "ZAPS_TEST_VAR");
    expect(after).toBeNull();
  });

  it("ZAPS_PANE_MAP stores valid pane map from createLayout", async () => {
    session = await createTestSession();
    const services: Record<string, ServiceConfig> = {
      api: { start: "echo api" },
      worker: { start: "echo worker" },
    };

    const { paneMap } = await createLayout(session.initialPaneId, undefined, services);

    // Serialize and store like cli.tsx does
    const serialized = JSON.stringify(paneMap);
    await setEnv(session.name, "ZAPS_PANE_MAP", serialized);

    // Read back and parse
    const raw = await showEnv(session.name, "ZAPS_PANE_MAP");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, string>;

    expect(parsed["@tui"]).toBe(paneMap["@tui"]);
    expect(parsed.api).toBe(paneMap.api);
    expect(parsed.worker).toBe(paneMap.worker);
  });
});
