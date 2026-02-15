import { build } from "esbuild";

await build({
  entryPoints: ["./src/cli.tsx"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "./dist/cli.mjs",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
});
