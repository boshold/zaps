import type { ProjectConfig, ZapsLib } from "./types.js";

export function createZapsLib(): ZapsLib {
  return {
    defineProject(config: ProjectConfig): ProjectConfig {
      return config;
    },
  };
}
