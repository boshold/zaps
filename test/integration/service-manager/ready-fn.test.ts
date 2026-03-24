import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ServiceManager } from "#src/lib/service/manager.js";
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { tmuxDeps } from "../helpers/service-manager.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { buildTestPaneMap, createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("ready-fn integration", () => {
  let session: TestSession;
  let mgr: ServiceManager;
  let markerFile: string;

  afterEach(async () => {
    try {
      await mgr.stopAll();
    } catch {
      // Best-effort stop
    }
    await session.cleanup();
  });

  it("ready: async function checks file existence", async () => {
    session = await createTestSession();
    markerFile = join(tmpdir(), `zaps-ready-${randomUUID().slice(0, 8)}`);
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: {
        // Start a process that creates marker file after 2s
        start: `node -e "setTimeout(()=>require('fs').writeFileSync('${markerFile}','ok'),2000);setInterval(()=>{},60000)"`,
        ready: async () => existsSync(markerFile),
      },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startService("svc");

    expect(mgr.getStatus("svc").state).toBe("ready");
    expect(existsSync(markerFile)).toBe(true);
  });
});
