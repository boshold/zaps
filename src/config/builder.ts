import type { Library, ProjectConfig } from "./types.js";

export function createZapsLib(): Library {
  return {
    defineProject(config: ProjectConfig): ProjectConfig {
      return config;
    },
  };
}
