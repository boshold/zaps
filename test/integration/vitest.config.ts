import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/integration/**/*.test.ts"],
    exclude: ["test/integration/shell/**", "**/node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: "forks",
    fileParallelism: false,
    // Global setup isolates all labels, including the managed server, via TMUX_TMPDIR.
    env: { ZAPS_TMUX_SOCKET: "zaps-test" },
    setupFiles: ["./test/integration/setup-tmux-socket.ts"],
    globalSetup: "./test/integration/global-setup.ts",
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/integration-tmux",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**"],
      exclude: ["src/config/native-babel.ts"],
    },
  },
});
