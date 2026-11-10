import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createTmuxIsolation(): { directory: string; cleanup: () => void } {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zaps-tmux-")));
  const socketDirectory = path.join(directory, `tmux-${os.userInfo().uid}`);

  return {
    directory,
    cleanup() {
      try {
        for (const socket of fs.readdirSync(socketDirectory)) {
          try {
            execFileSync("tmux", ["-S", path.join(socketDirectory, socket), "kill-server"], {
              stdio: "ignore",
            });
          } catch {
            /* Server already gone. */
          }
        }
      } catch {
        /* No server was started. */
      }
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
