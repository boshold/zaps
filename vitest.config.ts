import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    exclude: ["test/integration/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**"],
      thresholds: {
        lines: 80,
        functions: 90,
        branches: 90,
        statements: 80,
      },
    },
  },
});
