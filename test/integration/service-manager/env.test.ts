import { afterEach, describe, expect, it } from "vitest";

import { ServiceManager } from "#src/lib/service/manager.js";

import { managerDependencies } from "../../_helpers/service-runtime.js";
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

    mgr = new ServiceManager(config, managerDependencies(paneMap, tmuxDeps));
    await mgr.startService("svc");
    expect(mgr.getStatus("svc").state).toBe("ready");

    const response = await fetch(`http://127.0.0.1:${port}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("bar-value");
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

    mgr = new ServiceManager(config, managerDependencies(paneMap, tmuxDeps));
    await mgr.startAll();

    expect(mgr.getStatus("db").state).toBe("ready");
    expect(mgr.getStatus("api").state).toBe("ready");

    const response = await fetch(`http://127.0.0.1:${apiPort}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(String(dbPort));
  });
});
