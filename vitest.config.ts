import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    exclude: ["test/integration/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**"],
      exclude: ["src/cli.tsx"],
      thresholds: {
        lines: 85,
        functions: 92,
        branches: 87,
        statements: 85,
      },
    },
  },
});
