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
import { $ } from "bun";
import type { BunPlugin } from "bun";

const tlaFixPlugin: BunPlugin = {
  name: "tla-fix",
  setup(build) {
    // Yoga-layout: Replace TLA `await loadYoga()` with async IIFE + Proxy
    build.onLoad({ filter: /yoga-layout\/dist\/src\/index\.js$/ }, () => ({
      contents: `
import loadYoga from '../binaries/yoga-wasm-base64-esm.js';
import wrapAssembly from "./wrapAssembly.js";

let _yoga;
const _ready = (async () => { _yoga = wrapAssembly(await loadYoga()); })();

export default new Proxy({}, {
  get(_, p) { return p === "__yogaReady" ? _ready : _yoga[p]; },
  set(_, p, v) { _yoga[p] = v; return true; },
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

// Step 1 – bundle to single ESM file (TLA-free thanks to plugins)
const result = await Bun.build({
  entrypoints: ["./src/cli.tsx"],
  target: "bun",
  outdir: "./dist",
  naming: "cli.js",
  plugins: [tlaFixPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
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
await $`bun build dist/cli.js --compile --bytecode --outfile dist/zaps`;

// Cleanup intermediate
await $`rm dist/cli.js`;
