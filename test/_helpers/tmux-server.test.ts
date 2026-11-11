import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { cleanupTestTmuxServers } from "../integration/helpers/tmux-server.js";

async function listen(socketPath: string): Promise<net.Server> {
  const server = net.createServer((connection) => connection.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function close(server: net.Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

it("retains an unconfirmed owner root while still cleaning the other private server", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zt-cleanup-"));
  const firstPath = path.join(root, "first");
  const secondPath = path.join(root, "second");
  const first = await listen(firstPath);
  const second = await listen(secondPath);
  const attempted: string[] = [];
  const failure = new Error("Injected owned-server kill failure");
  try {
    await expect(
      cleanupTestTmuxServers([firstPath, secondPath], root, (socketPath) => {
        attempted.push(socketPath);
        if (socketPath === firstPath) {
          throw failure;
        }
        second.close();
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("retained"),
      errors: [
        expect.objectContaining({
          cause: expect.objectContaining({ errors: [failure, expect.any(Error)] }),
        }),
      ],
    });
    expect(attempted).toEqual([firstPath, secondPath]);
    expect(first.listening).toBe(true);
    expect(second.listening).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  } finally {
    await Promise.all([close(first), close(second)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("removes the root after independently confirming an already-gone server", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zt-cleanup-"));
  await cleanupTestTmuxServers([path.join(root, "gone")], root, () => {
    throw new Error("Server already gone");
  });
  expect(fs.existsSync(root)).toBe(false);
});
