/**
 * Sentra smoke check: prints `driver=<name>`.
 *
 *   tsx scripts/sentra-smoke.ts             # in-process (Node)
 *   tsx scripts/sentra-smoke.ts dist/zaps   # native binary, run from `/`
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { runSentraSmoke } from "#src/lib/sentra/smoke.js";

const EXPECTED_DRIVER = "node";

function fail(message: string): never {
  process.stderr.write(`sentra-smoke: ${message}\n`);
  process.exit(1);
}

async function resolveDriver(binary: string | undefined): Promise<string | null> {
  if (binary === undefined) {
    return runSentraSmoke();
  }
  // From `/` nothing can resolve from the repo's node_modules.
  const run = spawnSync(path.resolve(binary), [], {
    cwd: "/",
    encoding: "utf8",
    env: { ...process.env, ZAPS_SENTRA_SMOKE: "1" },
  });
  if (run.status !== 0) {
    fail(`binary exited with ${run.status}:\n${run.stderr}${run.stdout}`);
  }
  return run.stdout.trim().replace(/^driver=/, "");
}

const driver = await resolveDriver(process.argv[2]);
process.stdout.write(`driver=${driver}\n`);
if (driver !== EXPECTED_DRIVER) {
  fail(`expected driver "${EXPECTED_DRIVER}", got "${driver}"`);
}
