import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { build } from "esbuild";

await build({
  entryPoints: ["./src/cli.tsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "./dist/cli.mjs",
  packages: "external",
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
});

// Emit declarations
execSync("tsc -p tsconfig.build.json --emitDeclarationOnly", { stdio: "inherit" });

// Tsc strips /// <reference types="node" /> — prepend it so consumers
// Without their own @types/node can resolve node:* imports
const nodeDts = "./dist/config/node.d.ts";
const content = readFileSync(nodeDts, "utf8");
const directive = '/// <reference types="node" />\n';
if (!content.startsWith(directive)) {
  writeFileSync(nodeDts, directive + content);
}
