import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    exclude: ["test/integration/**", "node_modules/**"],
  },
});
