import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    esbuild: {
      jsx: "automatic",
      jsxImportSource: "react",
    },
  },
});
