import { execFileSync } from "node:child_process";

function killTestServer() {
  try {
    execFileSync("tmux", ["-L", "zaps-test", "kill-server"], { stdio: "ignore" });
  } catch {
    /* Server may already be gone */
  }
}

export default function setup() {
  killTestServer();
  return () => {
    killTestServer();
  };
}
