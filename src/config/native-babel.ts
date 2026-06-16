import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JitiOptions } from "jiti";
import babelAsset from "jiti/dist/babel.cjs" with { type: "file" };

import { daemonDir } from "#src/daemon/lifecycle.js";

/**
 * Native binary only: Bun embeds `babel.cjs` as a compile asset. `babelAsset`
 * is its path relative to this module inside the binary, so resolve it against
 * `import.meta.url`. jiti otherwise does a lazy `require("../dist/babel.cjs")`
 * that escapes Bun's bundler and fails inside `dist/zaps`. Copy the asset once
 * into the runtime dir and load it so it can be passed to `createJiti` via the
 * `transform` option.
 */
export function getNativeTransform(): JitiOptions["transform"] {
  const src = fileURLToPath(new URL(babelAsset, import.meta.url));
  const dest = path.join(daemonDir(), "babel.cjs");
  let needsCopy = true;
  try {
    needsCopy = fs.statSync(dest).size !== fs.statSync(src).size;
  } catch {
    // Dest missing — copy it
  }
  if (needsCopy) {
    fs.copyFileSync(src, dest);
  }
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- require() is typed any; babel.cjs is jiti's transform fn
  return createRequire(import.meta.url)(dest) as JitiOptions["transform"];
}
