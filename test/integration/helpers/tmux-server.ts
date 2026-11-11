import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function testTmuxSocketPath(socket: string, root = process.env.ZAPS_TEST_TMUX_ROOT): string {
  if (!root) {
    throw new Error("Private tmux fixture root is not initialized");
  }
  const directory = path.join(root, `tmux-${os.userInfo().uid}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, socket);
}

function initializeTestTmuxServer(socket: string): void {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  execFileSync(
    "tmux",
    [
      "-f",
      "/dev/null",
      "-S",
      testTmuxSocketPath(socket),
      "start-server",
      ";",
      "set-option",
      "-s",
      "exit-empty",
      "off",
      ";",
      "set-option",
      "-g",
      "default-shell",
      "/bin/sh",
    ],
    { env, stdio: "ignore", timeout: 5000 },
  );
}

async function socketIsAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath);
    connection.setTimeout(500);
    connection.once("connect", () => {
      connection.destroy();
      resolve(true);
    });
    connection.once("error", (error) => {
      connection.destroy();
      if ("code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
        resolve(false);
      } else {
        reject(error);
      }
    });
    connection.once("timeout", () => {
      connection.destroy();
      reject(new Error(`Cannot confirm private tmux socket state: ${socketPath}`));
    });
  });
}

async function confirmSocketGone(socketPath: string): Promise<void> {
  const deadline = Date.now() + 1000;
  let resetError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop -- wait for the owned listener to close
      if (!(await socketIsAlive(socketPath))) {
        return;
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ECONNRESET") {
        throw error;
      }
      resetError = error;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded polling of concrete socket state
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Private tmux socket closure was not confirmed: ${socketPath}`, {
    cause: resetError,
  });
}

async function cleanupTestTmuxServers(
  socketPaths: readonly string[],
  root: string,
  killServer: (socketPath: string) => void = (socketPath) => {
    execFileSync("tmux", ["-S", socketPath, "kill-server"], { stdio: "ignore", timeout: 5000 });
  },
): Promise<void> {
  const errors: unknown[] = [];
  for (const socketPath of socketPaths) {
    let killError: unknown;
    try {
      killServer(socketPath);
    } catch (error) {
      killError = error;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- independently settle every owned server
      await confirmSocketGone(socketPath);
    } catch (error) {
      errors.push(
        new Error(`Private tmux cleanup failed: ${socketPath}`, {
          cause:
            killError === undefined
              ? error
              : new AggregateError(
                  [killError, error],
                  "Kill failed and socket closure was not confirmed",
                ),
        }),
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Private tmux cleanup incomplete; retained ${root}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

export { cleanupTestTmuxServers, initializeTestTmuxServer, testTmuxSocketPath };
