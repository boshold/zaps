/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- IPC responses are untyped */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DaemonServer } from "#src/daemon/server.js";
import { ipcRequest } from "#src/lib/ipc/client.js";

export interface TestDaemon {
  socketPath: string;
  server: DaemonServer;
  cleanup: () => Promise<void>;
}

export async function createTestDaemon(): Promise<TestDaemon> {
  const socketPath = path.join(os.tmpdir(), `zaps-test-${randomUUID().slice(0, 8)}.sock`);
  const server = new DaemonServer();
  await server.start(socketPath);
  return {
    socketPath,
    server,
    async cleanup() {
      server.stop();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* Socket may already be cleaned up */
      }
    },
  };
}

/**
 * Write a minimal .zaps.mjs config that defines a single HTTP service.
 * Returns the absolute config path.
 */
export function writeTestConfig(dir: string, port: number): string {
  const configPath = path.join(dir, ".zaps.mjs");
  const cmd = `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>console.log('ready on port ${port}'))"`;
  fs.writeFileSync(
    configPath,
    [
      "export function config(lib) {",
      "  return lib.define({",
      '    name: "test-daemon",',
      "    services: {",
      "      web: {",
      `        start: ${JSON.stringify(cmd)},`,
      `        ready: { port: ${port} },`,
      "        raw: true,",
      "      },",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  return configPath;
}

/**
 * Write a .zaps.mjs config with two HTTP services (api + web) and a build task.
 */
export function writeMultiServiceConfig(dir: string, port1: number, port2: number): string {
  const configPath = path.join(dir, ".zaps.mjs");
  const apiCmd = `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port1},()=>console.log('ready on port ${port1}'))"`;
  const webCmd = `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port2},()=>console.log('ready on port ${port2}'))"`;
  fs.writeFileSync(
    configPath,
    [
      "export function config(lib) {",
      "  return lib.define({",
      '    name: "test-multi",',
      "    services: {",
      "      api: {",
      `        start: ${JSON.stringify(apiCmd)},`,
      `        ready: { port: ${port1} },`,
      "        raw: true,",
      "      },",
      "      web: {",
      `        start: ${JSON.stringify(webCmd)},`,
      `        ready: { port: ${port2} },`,
      "        raw: true,",
      "      },",
      "    },",
      "    tasks: {",
      "      build: {",
      '        name: "Build",',
      "        popup: true,",
      '        commands: "echo build-ok",',
      "      },",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
  );
  return configPath;
}

/**
 * Poll services.list until a service reaches the target state.
 */
export async function waitForServiceState(
  socketPath: string,
  session: string,
  service: string,
  targetState: string,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  /* eslint-disable no-await-in-loop -- Polling loop */
  while (Date.now() - start < timeoutMs) {
    const res = await ipcRequest(socketPath, "services.list", undefined, 5000, session);
    if (!res.error) {
      const statuses = res.result as { name: string; state: string }[];
      const svc = statuses.find((s) => s.name === service);
      if (svc?.state === targetState) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  /* eslint-enable no-await-in-loop */
  throw new Error(`Service '${service}' did not reach '${targetState}' within ${timeoutMs}ms`);
}

/**
 * Wait for all named services to reach a target state.
 */
export async function waitForAllServices(
  socketPath: string,
  session: string,
  services: string[],
  targetState: string,
  timeoutMs = 20_000,
): Promise<void> {
  const start = Date.now();
  /* eslint-disable no-await-in-loop -- Polling loop */
  while (Date.now() - start < timeoutMs) {
    const res = await ipcRequest(socketPath, "services.list", undefined, 5000, session);
    if (!res.error) {
      const statuses = res.result as { name: string; state: string }[];
      const allReady = services.every((name) => {
        const svc = statuses.find((s) => s.name === name);
        return svc?.state === targetState;
      });
      if (allReady) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  /* eslint-enable no-await-in-loop */
  throw new Error(
    `Services [${services.join(", ")}] did not all reach '${targetState}' within ${timeoutMs}ms`,
  );
}
