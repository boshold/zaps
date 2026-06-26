import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import type { Plugin } from "esbuild";
import { build } from "esbuild";

// Native-babel.ts uses a Bun-only `import ... with { type: "file" }` asset and
// Is only reachable in the native binary. Keep it out of the node bundle so
// Node never evaluates the Bun-specific import attribute.
const externalNativeBabel: Plugin = {
  name: "external-native-babel",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /native-babel(?:\.js)?$/ }, () => ({
      path: "./native-babel.js",
      external: true,
    }));
  },
};

/** Version for `zaps --version`: CI tag (ZAPS_VERSION) → package.json → "dev". */
function resolveVersion(): string {
  const envVersion = process.env.ZAPS_VERSION;
  if (envVersion) {
    return envVersion;
  }
  const parsed: unknown = JSON.parse(readFileSync("./package.json", "utf8"));
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof parsed.version === "string"
  ) {
    return parsed.version;
  }
  return "dev";
}

await build({
  entryPoints: ["./src/cli.tsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "./dist/cli.mjs",
  packages: "external",
  plugins: [externalNativeBabel],
  define: {
    __VERSION__: JSON.stringify(resolveVersion()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_BRANCH__: JSON.stringify(
      execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim(),
    ),
  },
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
