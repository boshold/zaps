import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/daemon/shutdown.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: "forks",
    fileParallelism: false,
  },
});
