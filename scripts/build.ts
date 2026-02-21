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
