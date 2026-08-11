import { detectPorts, getDescendantPids } from "#src/lib/port.js";
import type { ServiceManager } from "#src/lib/service/manager.js";
import type { ServiceStatus } from "#src/lib/service/types.js";
import {
  capturePane,
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

export const tmuxDeps = {
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
};

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
