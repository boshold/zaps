import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: "forks",
    fileParallelism: false,
  },
});
