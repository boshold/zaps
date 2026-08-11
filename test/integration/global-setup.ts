import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Every integration file runs on its own `zaps-test-*` socket (see
 * `setup-tmux-socket.ts`), so reap all of them: tmux keeps one socket file per
 * server under `/tmp/tmux-<uid>/`. A file's own `afterAll` normally kills its
 * server; this catches whatever a crashed worker left behind.
 */
function killTestServers() {
  const sockets = new Set(["zaps-test"]);
  try {
    const dir = path.join(os.tmpdir(), `tmux-${os.userInfo().uid}`);
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith("zaps-test")) {
        sockets.add(entry);
      }
    }
  } catch {
    /* No tmux socket dir yet — nothing to reap */
  }
  for (const socket of sockets) {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      /* Server may already be gone */
    }
  }
}

export default function setup() {
  // Strip inherited tmux client env so the integration tmux commands don't nest
  // When the suite is run from inside a tmux session locally (otherwise the test
  // Server exits unexpectedly). CI runs outside tmux, so this is a no-op there.
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  killTestServers();
  return () => {
    killTestServers();
  };
}
