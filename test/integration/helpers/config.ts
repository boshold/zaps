import type { ResolvedConfig, ServiceConfig } from "#src/config/types.js";

export function makeConfig(
  services: Record<string, ServiceConfig>,
  hooks?: ResolvedConfig["project"]["hooks"],
): ResolvedConfig {
  return {
    project: {
      name: "integration-test",
      services,
      hooks,
    },
    configPath: "/tmp/.zaps.ts",
    projectDir: "/tmp",
  };
}
