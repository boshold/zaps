import { execFileSync } from "node:child_process";

export default function setup() {
  return () => {
    try {
      execFileSync("tmux", ["-L", "zaps-test", "kill-server"], { stdio: "ignore" });
    } catch {
      /* Server may already be gone */
    }
  };
}
