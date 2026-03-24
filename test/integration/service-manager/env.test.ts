import { ServiceManager } from "#src/lib/service/manager.js";
import { capturePane } from "#src/lib/tmux.js";
import { afterEach, describe, expect, it } from "vitest";

import { makeConfig } from "../helpers/config.js";
import { httpServerCmd } from "../helpers/fixtures.js";
import { getFreePort } from "../helpers/port.js";
import { tmuxDeps } from "../helpers/service-manager.js";
import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { buildTestPaneMap, createTestSession } from "../helpers/tmux.js";

describe.skipIf(!hasTmux())("env integration", () => {
  let session: TestSession;
  let mgr: ServiceManager;

  afterEach(async () => {
    try {
      await mgr.stopAll();
    } catch {
      // Best-effort stop
    }
    await session.cleanup();
  });

  it("static env vars passed to service", async () => {
    session = await createTestSession();
    const port = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["svc"]);

    const config = makeConfig({
      svc: {
        start: `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end(process.env.FOO||'')}).listen(${port},()=>console.log('ready on port ${port}'))"`,
        ready: { port },
        env: { FOO: "bar-value" },
      },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startService("svc");
    expect(mgr.getStatus("svc").state).toBe("ready");

    // Verify env was passed by checking the command in pane capture
    const output = await capturePane(paneMap.svc, 50);
    expect(output).toContain("FOO=");
  });

  it("dynamic env from service context", async () => {
    session = await createTestSession();
    const dbPort = await getFreePort();
    const apiPort = await getFreePort();
    const paneMap = await buildTestPaneMap(session.initialPaneId, ["db", "api"]);

    const config = makeConfig({
      db: { start: httpServerCmd(dbPort), ready: { port: dbPort } },
      api: {
        start: `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end(process.env.DB_PORT||'')}).listen(${apiPort},()=>console.log('ready on port ${apiPort}'))"`,
        ready: { port: apiPort },
        dependsOn: ["db"],
        env: (ctx) => ({ DB_PORT: String(ctx.services.db.port ?? "") }),
      },
    });

    mgr = new ServiceManager(config, paneMap, tmuxDeps, session.name);
    await mgr.startAll();

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("api").state).toBe("ready");

    // The api pane should show the env prefix with DB_PORT
    const output = await capturePane(paneMap.api, 50);
    expect(output).toContain("DB_PORT=");
  });
});
