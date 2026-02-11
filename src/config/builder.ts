import type { Library, ProjectConfig } from "./types.js";
import { z } from "zod";

import { projectConfigSchema } from "./schema.js";

export function createZapsLib(): Library {
  return {
    defineProject(config: ProjectConfig): ProjectConfig {
      try {
        return projectConfigSchema.parse(config);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new Error(
            error.issues
              .map((i) => {
                const path = i.path.length ? `${i.path.join(".")}: ` : "";
                return `${path}${i.message}`;
              })
              .join("\n"),
            { cause: error },
          );
        }
        throw error;
      }
    },
  };
}
