import type { ResolvedConfig, ServiceConfig, TaskConfig } from "#src/config/types.js";

export function makeConfig(
  services: Record<string, ServiceConfig>,
  opts?: {
    hooks?: ResolvedConfig["project"]["hooks"];
    tasks?: Record<string, TaskConfig>;
  },
): ResolvedConfig {
  return {
    project: {
      name: "integration-test",
      services,
      hooks: opts?.hooks,
      tasks: opts?.tasks,
    },
    configPath: "/tmp/.zaps.ts",
    projectDir: "/tmp",
  };
}
