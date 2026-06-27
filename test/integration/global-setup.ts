import { execFileSync } from "node:child_process";

function killTestServer() {
  try {
    execFileSync("tmux", ["-L", "zaps-test", "kill-server"], { stdio: "ignore" });
  } catch {
    /* Server may already be gone */
  }
}

export default function setup() {
  // Strip inherited tmux client env so the integration tmux commands don't nest
  // When the suite is run from inside a tmux session locally (otherwise the test
  // Server exits unexpectedly). CI runs outside tmux, so this is a no-op there.
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  killTestServer();
  return () => {
    killTestServer();
  };
}
