/**
 * Build script: bundle with Bun.build() API → compile with --bytecode.
 *
 * Three issues prevent direct bytecode compilation:
 * 1. yoga-layout — TLA `await loadYoga()` at module scope
 * 2. ink reconciler — TLA `await import('./devtools.js')` guarded by DEV
 * 3. import.meta.* — JSC bytecode compiler doesn't support import.meta
 *    (Bun issues #14954, #18778)
 *
 * (1) and (2) are fixed with build plugins. (3) is fixed by post-processing
 * the bundle to replace import.meta.require → require and import.meta.url →
 * a __filename-based equivalent.
 */
import { createRequire } from "node:module";
import path from "node:path";

import { $ } from "bun";
import type { BunPlugin } from "bun";

const require = createRequire(import.meta.url);

// Jiti's exports map blocks the deep `jiti/dist/babel.cjs` import the loader
// Embeds as a Bun file asset. Resolve it to the real path and force the `file`
// Loader so it is embedded as an opaque asset (default export = runtime path)
// Rather than bundled as a CJS module — embedding keeps `--bytecode` working.
const babelPath = path.join(
  path.dirname(require.resolve("jiti/package.json")),
  "dist",
  "babel.cjs",
);
const babelAssetPlugin: BunPlugin = {
  name: "jiti-babel-asset",
  setup(build) {
    build.onResolve({ filter: /^jiti\/dist\/babel\.cjs$/ }, () => ({
      path: babelPath,
      namespace: "babel-asset",
    }));
    build.onLoad({ filter: /.*/, namespace: "babel-asset" }, async () => ({
      contents: await Bun.file(babelPath).bytes(),
      loader: "file",
    }));
  },
};

const tlaFixPlugin: BunPlugin = {
  name: "tla-fix",
  setup(build) {
    // Yoga-layout: Force all imports to resolve to the hoisted copy so the
    // Bundler produces a single module instance (pnpm may create two paths).
    build.onResolve({ filter: /^yoga-layout$/ }, () => ({
      path: require.resolve("yoga-layout"), // eslint-disable-line unicorn/prefer-module -- Bun build plugin requires synchronous resolve
    }));

    // Yoga-layout: Replace TLA `await loadYoga()` with async IIFE + Proxy
    build.onLoad({ filter: /yoga-layout\/dist\/src\/index\.js$/ }, () => ({
      contents: `
import loadYoga from '../binaries/yoga-wasm-base64-esm.js';
import wrapAssembly from "./wrapAssembly.js";

const _ref = [null];
const _ready = (async () => { _ref[0] = wrapAssembly(await loadYoga()); })();

export default new Proxy({}, {
  get(_, p) {
    if (p === "__yogaReady") return _ready;
    if (!_ref[0]) throw new Error("Yoga not ready — await __yogaReady first");
    return _ref[0][p];
  },
  set(_, p, v) { _ref[0][p] = v; return true; },
});
export * from "./generated/YGEnums.js";
`,
      loader: "js",
    }));

    // Ink reconciler: Strip the devtools TLA block
    build.onLoad({ filter: /ink\/build\/reconciler\.js$/ }, async (args) => {
      let contents = await Bun.file(args.path).text();
      contents = contents.replace(
        /\/\/ We need to conditionally perform devtools[\s\S]*?^}\n/m,
        "",
      );
      return { contents, loader: "js" };
    });
  },
};

/** Version for `zaps --version`: CI tag (ZAPS_VERSION) → package.json → "dev". */
function resolveVersion(envVersion: string | undefined, parsed: unknown): string {
  if (envVersion) {
    return envVersion;
  }
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

// Step 1 – bundle to single ESM file (TLA-free thanks to plugins)
const branchOutput = await $`git rev-parse --abbrev-ref HEAD`.text();
const branchName = branchOutput.trim();
// Version for `zaps --version`: CI tag (ZAPS_VERSION) → package.json → "dev".
const pkgJson: unknown = await Bun.file("package.json").json();
const version = resolveVersion(process.env.ZAPS_VERSION, pkgJson);
const result = await Bun.build({
  entrypoints: ["./src/cli.tsx"],
  target: "bun",
  outdir: "./dist",
  naming: "cli.js",
  plugins: [tlaFixPlugin, babelAssetPlugin],
  define: {
    __VERSION__: JSON.stringify(version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_BRANCH__: JSON.stringify(branchName),
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log); // eslint-disable-line no-console -- Build script output
  }
  process.exit(1);
}

// Step 2 – replace import.meta.* for bytecode compatibility
// JSC's bytecode compiler rejects import.meta (Bun #14954, #18778)
let code = await Bun.file("dist/cli.js").text();
code = code
  .replace("var __require = import.meta.require;", "var __require = require;")
  .replaceAll("import.meta.url", "require('url').pathToFileURL(__filename).href");
await Bun.write("dist/cli.js", code);

// Step 3 – compile to self-contained bytecode binary
const targetArg = process.argv.find((a) => a.startsWith("--target="));
const target = targetArg?.split("=")[1];

const compileArgs = [
  "bun",
  "build",
  "dist/cli.js",
  "--compile",
  "--bytecode",
  "--outfile",
  "dist/zaps",
];
if (target) {
  compileArgs.push(`--target=${target}`);
}

await $`${compileArgs}`;

// Cleanup intermediate
await $`rm dist/cli.js`;

// Emit declarations
const { execSync } = await import("node:child_process");
execSync("tsc -p tsconfig.build.json --emitDeclarationOnly", { stdio: "inherit" });

// Tsc strips /// <reference types="node" /> — prepend it so consumers
// Without their own @types/node can resolve node:* imports
const nodeDts = "./dist/config/node.d.ts";
const dtsContent = await Bun.file(nodeDts).text();
const directive = '/// <reference types="node" />\n';
if (!dtsContent.startsWith(directive)) {
  await Bun.write(nodeDts, directive + dtsContent);
}
