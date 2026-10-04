import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

const portStateSchema = z.object({ port: z.number().int().min(1).max(65_535) });

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** `$XDG_STATE_HOME/zaps`, else `~/.local/state/zaps` (relative XDG values are ignored per spec). */
export function sentraStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, "zaps");
  }
  return path.join(os.homedir(), ".local", "state", "zaps");
}

export function sentraDbPath(): string {
  return path.join(sentraStateDir(), "sentra.db");
}

export function sentraPortStatePath(): string {
  return path.join(sentraStateDir(), "sentra.json");
}

/** Last bound port, or `null` when the file is missing or invalid. */
export function readPortState(file = sentraPortStatePath()): number | null {
  const parsed = portStateSchema.safeParse(readJson(file));
  return parsed.success ? parsed.data.port : null;
}

/** Atomic (tmp file + rename), so a concurrent reader never sees a partial file. */
export function writePortState(port: number, file = sentraPortStatePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(portStateSchema.parse({ port }))}\n`);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
