import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { createRawPaneLaunch } from "#src/lib/backend/tmux/raw-launch.js";
import { shellEscape } from "#src/lib/service/env.js";

it("holds payload until acknowledgement and releases the private holder afterwards", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-raw-payload-"));
  const marker = path.join(folder, "executed");
  const payload = `${shellEscape(process.execPath)} -e ${shellEscape(`require("fs").writeFileSync(${JSON.stringify(marker)},"executed")`)}`;
  const launch = createRawPaneLaunch(payload, () => {
    /* Active execution. */
  });
  const privateFolder = path.dirname(launch.file);
  const child = spawn("sh", [launch.file], { stdio: "ignore", detached: true });
  const closed = once(child, "close");
  try {
    expect(await launch.holder()).toBe(child.pid);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.statSync(privateFolder).mode % 0o1000).toBe(0o700);
    expect(fs.statSync(path.join(privateFolder, "go")).mode % 0o1000).toBe(0o600);
    expect(await launch.confirm()).toBe(child.pid);
    expect(fs.existsSync(marker)).toBe(false);
    await launch.start();
    await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true));
    expect(child.exitCode).toBeNull();
    launch.release();
    await closed;
    expect(child.exitCode).toBe(0);
  } finally {
    launch.dispose();
    child.kill("SIGKILL");
    fs.rmSync(folder, { recursive: true, force: true });
  }
  expect(fs.existsSync(privateFolder)).toBe(false);
});

it("cancellation closes the gate without running payload or retaining private files", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-raw-cancel-"));
  const marker = path.join(folder, "executed");
  let active = true;
  const launch = createRawPaneLaunch(`printf executed > ${shellEscape(marker)}`, () => {
    if (!active) {
      throw new Error("cancelled");
    }
  });
  const privateFolder = path.dirname(launch.file);
  const child = spawn("sh", [launch.file], { stdio: "ignore", detached: true });
  const closed = once(child, "close");
  try {
    expect(await launch.holder()).toBe(child.pid);
    active = false;
    await expect(launch.start()).rejects.toThrow("cancelled");
    launch.dispose();
    await closed;
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(privateFolder)).toBe(false);
  } finally {
    launch.dispose();
    child.kill("SIGKILL");
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

it("bounds missing holder acknowledgement and removes all private resources", async () => {
  vi.useFakeTimers();
  const launch = createRawPaneLaunch("exit 0", () => {
    /* Active execution. */
  });
  const privateFolder = path.dirname(launch.file);
  try {
    const failed = expect(launch.holder()).rejects.toThrow("acknowledgement deadline");
    await vi.advanceTimersByTimeAsync(1000);
    await failed;
  } finally {
    launch.dispose();
    vi.useRealTimers();
  }
  expect(fs.existsSync(privateFolder)).toBe(false);
});
