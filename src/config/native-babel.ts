import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { JitiOptions } from "jiti";
import babelSource from "jiti/dist/babel.cjs" with { type: "text" };

import { daemonDir } from "#src/daemon/lifecycle.js";

/**
 * Native binary only: jiti otherwise does a lazy `require("../dist/babel.cjs")`
 * that escapes Bun's bundler and fails inside `dist/zaps`. The build inlines
 * `babel.cjs` as text (`type: "text"`), so `babelSource` is its source string —
 * carried inside the binary, not a build-time path (a file asset is dropped by
 * the `--compile --bytecode` step, leaving a dangling path; see scripts/build-native.ts).
 * Write the source once into the runtime dir and `require` it so it can be passed
 * to `createJiti` via the `transform` option.
 */
export function getNativeTransform(): JitiOptions["transform"] {
  const dest = path.join(daemonDir(), "babel.cjs");
  const expectedSize = Buffer.byteLength(babelSource);
  let needsWrite = true;
  try {
    needsWrite = fs.statSync(dest).size !== expectedSize;
  } catch {
    // Dest missing — write it
  }
  if (needsWrite) {
    fs.writeFileSync(dest, babelSource);
  }
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- require() is typed any; babel.cjs is jiti's transform fn
  return createRequire(import.meta.url)(dest) as JitiOptions["transform"];
}
