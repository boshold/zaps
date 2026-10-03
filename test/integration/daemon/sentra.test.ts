import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requestDaemon } from "#src/cli/helpers.js";
import { createAutoStartRequest, runSentraCli } from "#src/cli/sentra.js";
import type { SentraCliDeps } from "#src/cli/sentra.js";
import { DaemonServer } from "#src/daemon/server.js";
import { ipcRequest } from "#src/lib/ipc/client.js";
import { SentraHost } from "#src/lib/sentra/host.js";
import { errorsResultSchema } from "#src/lib/sentra/schemas.js";
import type { ErrorRow } from "#src/lib/sentra/schemas.js";
import { computeProjectSessionId } from "#src/lib/sentra/session-id.js";

import { hasTmux } from "../helpers/skip.js";
import type { TestSession } from "../helpers/tmux.js";
import { createTestSession, testTmuxSocket } from "../helpers/tmux.js";
import { waitFor } from "../helpers/wait.js";

const FIXTURE = path.resolve("test/integration/fixtures/sentra-app/app.mjs");
const SERVICE = "app";

function writeSentraConfig(dir: string): string {
  const configPath = path.join(dir, ".zaps.mts");
  fs.writeFileSync(
    configPath,
    [
      "export function config(lib) {",
      "  return lib.define({",
      '    name: "sentra-it",',
      '    sentra: { env: { SENTRY_DSN: "{dsn}" } },',
      "    services: {",
      `      ${SERVICE}: { start: ${JSON.stringify(`node ${FIXTURE}`)}, raw: true, sentra: true },`,
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  return configPath;
}

describe.skipIf(!hasTmux())("sentra end-to-end with @sentry/node", () => {
  let tmpDir = "";
  let projectDir = "";
  let stateDir = "";
  let socketPath = "";
  let daemon: DaemonServer | null = null;
  let tmux: TestSession;
  let previousStateHome: string | undefined = undefined;

  async function startDaemon(): Promise<string> {
    const server = new DaemonServer({
      sentraHost: new SentraHost({
        dbPath: path.join(stateDir, "zaps", "sentra.db"),
        portStatePath: path.join(stateDir, "zaps", "sentra.json"),
      }),
    });
    await server.start(socketPath);
    daemon = server;
    return socketPath;
  }

  async function stopDaemon(): Promise<void> {
    if (!daemon) {
      return;
    }
    const server = daemon;
    daemon = null;
    for (const session of server.list()) {
      // oxlint-disable-next-line no-await-in-loop -- sequential teardown
      await server.destroy(session.id).catch(() => {
        /* Best-effort */
      });
    }
    server.stop();
    await server.sentra.close();
    fs.rmSync(socketPath, { force: true });
  }

  function cliDeps(argv: string[], out: string[], err: string[]): SentraCliDeps {
    return {
      request: createAutoStartRequest({
        request: async (sock, method, params) => requestDaemon(sock, method, params, 30_000),
        socket: () => socketPath,
        ensureDaemon: startDaemon,
      }),
      cwd: () => projectDir,
      configSessionId: async () => computeProjectSessionId(projectDir),
      argv,
      env: {},
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    };
  }

  async function sentra(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSentraCli(args, cliDeps(["sentra", ...args], out, err));
    return { code, out: out.join(""), err: err.join("") };
  }

  async function errorsJson(args: string[]): Promise<ErrorRow[]> {
    const res = await sentra(["errors", ...args, "--json"]);
    expect(res.err).toBe("");
    return errorsResultSchema.parse(JSON.parse(res.out)).errors;
  }

  beforeAll(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zaps-sentra-it-")));
    projectDir = path.join(tmpDir, "project");
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(projectDir);
    fs.mkdirSync(stateDir);
    previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    socketPath = path.join(tmpDir, "zaps.sock");
    tmux = await createTestSession();
    await startDaemon();
  });

  afterAll(async () => {
    await stopDaemon();
    await tmux.cleanup();
    if (previousStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousStateHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures an SDK error, shows it, and still reads it after the session is gone", async () => {
    const t0 = new Date().toISOString();
    const configPath = writeSentraConfig(projectDir);
    const created = await ipcRequest(socketPath, "session.create", {
      configPath,
      projectDir,
      tmuxSession: tmux.name,
      originPane: tmux.initialPaneId,
      tmuxSocket: testTmuxSocket(),
    });
    expect(created.error).toBeUndefined();

    const rows = await waitFor(
      async () => errorsJson(["--from", t0]),
      (value) => value.length > 0,
      15_000,
      250,
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.title).toContain("zaps-sentra-it");
    expect(row.service).toBe(SERVICE);
    expect(row.location).toContain("fixtures/sentra-app/app.mjs");

    const shown = await sentra(["show", row.id]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("fixtures/sentra-app/app.mjs");

    await stopDaemon();

    const after = await errorsJson(["--since", "5m"]);
    expect(after.map((r) => r.id)).toEqual([row.id]);
    expect(daemon).not.toBeNull();
  });
});
