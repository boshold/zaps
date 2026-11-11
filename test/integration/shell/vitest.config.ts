import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/shell/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: "forks",
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "coverage/integration-shell",
      include: ["src/**"],
      exclude: ["src/config/native-babel.ts"],
    },
  },
});
