import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSentra, sqliteStorage } from "@boshold/sentra-core";

/** Opens a throwaway SQLite-backed Sentra and returns the loaded driver. */
export async function runSentraSmoke(): Promise<string | null> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zaps-sentra-smoke-"));
  try {
    const sentra = await createSentra({
      storage: sqliteStorage({ path: path.join(dir, "smoke.db") }),
    });
    try {
      return sentra.info().storage.driver;
    } finally {
      await sentra.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
