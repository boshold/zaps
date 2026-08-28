import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // `.direnv/` holds a nix copy of this repo — never glob tests out of it.
    exclude: ["test/integration/**", "**/node_modules/**", "**/.direnv/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**"],
      exclude: ["src/cli.tsx", "src/config/native-babel.ts"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
  },
});
