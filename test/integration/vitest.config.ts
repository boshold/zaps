import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: "forks",
    fileParallelism: false,
    env: { ZAPS_TMUX_SOCKET: "zaps-test" },
    globalSetup: "./test/integration/global-setup.ts",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**"],
      exclude: ["src/config/native-babel.ts"],
    },
  },
});
