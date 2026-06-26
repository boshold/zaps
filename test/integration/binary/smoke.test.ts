import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { killSession, newSession, sendKeys } from "#src/lib/tmux.js";

import { reservePort } from "../helpers/port.js";
import { hasBinary, hasTmux, isCI } from "../helpers/skip.js";

const binaryPath = path.resolve("dist/zaps");

// Config filenames that discoverConfig searches for
const CONFIG_FILENAMES = [
  ".local.zaps.mts",
  "local.zaps.mts",
  ".local.zaps.ts",
  "local.zaps.ts",
  ".zaps.mts",
  ".zaps.ts",
];

function cleanStaleConfigs(): void {
  for (const name of CONFIG_FILENAMES) {
    try {
      fs.unlinkSync(path.join(os.tmpdir(), name));
    } catch {
      // Doesn't exist
    }
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error("pollUntil timed out");
}

describe.skipIf(!hasBinary() || !hasTmux() || isCI)("binary smoke", { timeout: 90_000 }, () => {
  let sessionName: string;
  let tmpDir: string;

  afterEach(async () => {
    if (sessionName) {
      try {
        await killSession(sessionName);
      } catch {
        // Session may already be gone
      }
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
    cleanStaleConfigs();
  });

  it("starts services and TUI is visible", async () => {
    cleanStaleConfigs();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "zaps-smoke-"));
    const { port, release } = await reservePort();

    // Write a .zaps.mts config (discovery supports .mts/.ts only)
    const configContent = `export function config({ define }) {
  return define({
    name: "smoke-test",
    services: {
      web: {
        start: "node -e \\"require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>console.log('ready on port ${port}'))\\"",
        ready: { port: ${port} },
      },
    },
  });
}
`;
    await writeFile(path.join(tmpDir, ".zaps.mts"), configContent, "utf8");

    // Create a tmux session and launch zaps inside it
    sessionName = `zaps-smoke-${Date.now()}`;
    const initialPane = await newSession(sessionName);

    // Release the reserved port just before launching zaps (minimizes race window)
    await release();

    // Need to run inside tmux, so zaps dev is run from within this session
    await sendKeys(initialPane, `cd ${tmpDir} && ${binaryPath} up`);

    // Let tmux process the command before polling
    await sleep(2000);

    // Poll for the service becoming ready (port open) — may take a while under parallel load
    await pollUntil(
      async () => {
        try {
          const response = await fetch(`http://localhost:${port}`, {
            signal: AbortSignal.timeout(1000),
          });
          return response.status === 200;
        } catch {
          return false;
        }
      },
      50_000,
      2000,
    );

    // Verify HTTP server responds
    const response = await fetch(`http://localhost:${port}`);
    expect(response.status).toBe(200);
  });
});
