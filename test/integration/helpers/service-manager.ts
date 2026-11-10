import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createProcessInspection } from "#src/lib/backend/runtime/process-inspection.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import { TmuxRuntime, WrapperRegistry } from "#src/lib/backend/tmux/runtime.js";
import { detectPorts, getDescendantPids } from "#src/lib/port.js";
import { shellEscape } from "#src/lib/service/env.js";
import type { ServiceManager, ServiceManagerDeps } from "#src/lib/service/manager.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import {
  capturePane,
  displayPopup,
  getWindowName,
  getWindowOption,
  panePid,
  renameWindow,
  sendCtrlC,
  sendKeys,
  setWindowOption,
  tmuxFor,
} from "#src/lib/tmux.js";

import { testTmuxSocket } from "./tmux.js";

type LegacyDeps = Omit<ServiceManagerDeps, "runtime" | "inspectPorts">;
function withServiceRuntime<T extends LegacyDeps>(
  deps: T,
): T & Pick<ServiceManagerDeps, "runtime" | "inspectPorts"> {
  return Object.assign(deps, {
    runtime: (targets: Record<string, string>) =>
      new TmuxRuntime({
        tmux: {
          ...tmuxFor(testTmuxSocket()),
          sendKeys: deps.sendKeys,
          sendCtrlC: deps.sendCtrlC,
          panePid: deps.panePid,
          capturePane: async (target: string, lines?: number) =>
            deps.capturePane(target, lines ?? 500),
        },
        processes: new ProcessRunner({
          onLines: () => {
            /* Runtime event sink. */
          },
          onExit: () => {
            /* Runtime event sink. */
          },
          spawn: deps.detachedSpawn,
          record: async (pid) => deps.recordDetached?.(pid),
          unrecord: async (pid) => deps.removeDetached?.(pid),
        }),
        environmentFile: (env) => {
          const file = path.join(os.tmpdir(), `zaps-test-env-${randomUUID()}`);
          fs.writeFileSync(
            file,
            Object.entries(env)
              .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
              .map(([key, value]) => `export ${key}=${shellEscape(value)}`)
              .join("\n"),
            { flag: "wx", mode: 0o600 },
          );
          return file;
        },
        removeEnvironmentFile: (file) => fs.rmSync(file, { force: true }),
        wrappers: new WrapperRegistry(),
        sessionId: deps.sessionId,
        zapsCommand: deps.zapsCommand,
        paneFor: (name) => {
          const pane = targets[name];
          if (!pane) {
            throw new Error(`No pane: ${name}`);
          }
          return pane;
        },
        getDescendantPids: deps.getDescendantPids,
      }),
    inspectPorts: async (pid: number) =>
      deps.detectPortsForPid
        ? deps.detectPortsForPid(pid)
        : createProcessInspection().detectPortsForPid(pid),
  });
}

export const tmuxDeps = withServiceRuntime({
  sendKeys,
  sendCtrlC,
  panePid,
  detectPorts: async (paneTarget: string) => detectPorts(paneTarget, tmuxFor(testTmuxSocket())),
  capturePane,
  getDescendantPids,
  renameWindow,
  getWindowName,
  getWindowOption,
  setWindowOption,
  displayPopup,
  exec: async () => {
    /* No-op */
  },
  preflightPorts: async () => null,
  storeExecInfo: () => {
    /* No-op */
  },
  sessionId: "test-session-id",
  zapsCommand: "zaps",
  reflowInsert: async () => {
    /* No-op for tests that don't exercise lazy lifecycle */
  },
  reflowRemove: async () => {
    /* No-op */
  },
});

export async function waitForState(
  mgr: ServiceManager,
  name: string,
  target: string,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (mgr.getStatus(name).state === target) {
      resolve();
      return;
    }
    function listener(n: string, status: ServiceStatus) {
      if (n === name && status.state === target) {
        clearTimeout(timer); // eslint-disable-line no-use-before-define -- circular timer/listener
        mgr.removeListener("stateChange", listener);
        resolve();
      }
    }

    const timer = setTimeout(() => {
      mgr.removeListener("stateChange", listener);
      reject(new Error(`Timed out waiting for ${name} to reach ${target}`));
    }, timeoutMs);
    mgr.on("stateChange", listener);
  });
}

export { withServiceRuntime };
