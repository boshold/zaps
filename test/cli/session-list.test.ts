import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { parseSessionList, unavailableCapabilities } from "../../src/lib/backend/wire.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const common = {
  id: "session",
  name: "project",
  configPath: "/project/.zaps.mts",
  projectDir: "/project",
  createdAt: 1,
};
const shell = { ...common, backend: "shell", capabilities: unavailableCapabilities };
const legacy = { ...common, id: "legacy", tmuxSession: "work", managed: true, tuiPane: "%1" };
const requestSchema = z.object({ id: z.string(), method: z.literal("session.list") });

describe("CLI session list metadata", () => {
  let directory = "";
  let response: unknown;
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const request = requestSchema.parse(JSON.parse(buffer.slice(0, newline)));
      socket.end(`${JSON.stringify({ id: request.id, result: response })}\n`);
    });
  });

  beforeEach(async () => {
    response = [shell, legacy];
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-ls-"));
    await new Promise<void>((resolve) => server.listen(path.join(directory, "d.sock"), resolve));
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function run(flags: string[] = [], socket = path.join(directory, "d.sock")) {
    const child = spawn(
      process.execPath,
      ["--import", tsxImport, path.join(repoRoot, "src/cli.tsx"), "ls", ...flags],
      {
        cwd: directory,
        env: {
          ...process.env,
          ZAPS_SOCKET_PATH: socket,
          TMUX: "/ambient/tmux,1,0",
          CLAUDECODE: undefined,
          CURSOR_TRACE_DIR: undefined,
          ZAPS_FORMAT: undefined,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { stdout, stderr, code };
  }

  it("shows stored backend and blank shell location despite ambient tmux", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]?.trimEnd()).toMatch(/^session\s+project\s+\/project\s+shell$/);
    expect(lines[1]).toMatch(/^legacy\s+project\s+\/project\s+tmux\s+work \(managed\)$/);
  });

  it.each(["json", "toon"])("validates and normalizes %s output", async (format) => {
    const result = await run([`--${format}`]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const data: unknown = format === "json" ? JSON.parse(result.stdout) : decode(result.stdout);
    expect(parseSessionList(data)).toEqual(parseSessionList(response));
    expect(data).toEqual([
      shell,
      { ...legacy, backend: "tmux", capabilities: unavailableCapabilities },
    ]);
  });

  it.each([
    { backend: "other", capabilities: unavailableCapabilities },
    { backend: "shell" },
    { capabilities: unavailableCapabilities },
    { backend: "shell", capabilities: { ...unavailableCapabilities, panes: true } },
    { backend: "shell", capabilities: unavailableCapabilities, tmuxSession: "fake" },
  ])("rejects explicit malformed metadata %j", async (metadata) => {
    response = [{ ...common, ...metadata }];
    const result = await run(["--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });

  it.each(["json", "toon"])("keeps empty and absent-daemon %s output valid", async (format) => {
    response = [];
    for (const socket of [path.join(directory, "d.sock"), path.join(directory, "missing.sock")]) {
      const result = await run([`--${format}`], socket);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const data: unknown = format === "json" ? JSON.parse(result.stdout) : decode(result.stdout);
      expect(data).toEqual([]);
    }
  });
});
