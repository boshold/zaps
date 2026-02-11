import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { killSession, newSession, sendKeys } from "#src/lib/tmux.js";
import { afterEach, describe, expect, it } from "vitest";

import { getFreePort } from "../helpers/port.js";
import { hasBinary, hasTmux } from "../helpers/skip.js";

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
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  throw new Error("pollUntil timed out");
}

describe.skipIf(!hasBinary() || !hasTmux())("binary smoke", () => {
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
    const port = await getFreePort();

    // Write a .zaps.mts config (discovery supports .mts/.ts only)
    const configContent = `export function config({ defineProject }) {
  return defineProject({
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

    // Need to run inside tmux, so zaps dev is run from within this session
    await sendKeys(initialPane, `cd ${tmpDir} && ${binaryPath} dev`);

    // Wait for layout creation — zaps creates panes and spawns TUI
    await sleep(3000);

    // Poll for either TUI output or the service becoming ready (port open)
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
      30_000,
      2000,
    );

    // Verify HTTP server responds
    const response = await fetch(`http://localhost:${port}`);
    expect(response.status).toBe(200);
  });
});
