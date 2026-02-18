import { openInBrowser } from "#src/lib/open.js";
import type { Library, LibraryActions, ProjectConfig } from "./types.js";
import { z } from "zod";

import { projectConfigSchema } from "./schema.js";

export interface ZapsLib {
  lib: Library;
  bindActions: (actions: LibraryActions) => void;
}

export function createZapsLib(): ZapsLib {
  let actions: LibraryActions | null = null;

  return {
    lib: {
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
      async runTask(key: string): Promise<void> {
        if (!actions) {
          throw new Error("runTask is not available outside of service hooks");
        }
        await actions.runTask(key);
      },
      async startService(name: string): Promise<void> {
        if (!actions) {
          throw new Error("startService is not available outside of service hooks");
        }
        await actions.startService(name);
      },
      async restartService(name: string): Promise<void> {
        if (!actions) {
          throw new Error("restartService is not available outside of service hooks");
        }
        await actions.restartService(name);
      },
      async stopService(name: string): Promise<void> {
        if (!actions) {
          throw new Error("stopService is not available outside of service hooks");
        }
        await actions.stopService(name);
      },
      isServiceRunning(name: string): boolean {
        if (!actions) {
          throw new Error("isServiceRunning is not available outside of service hooks");
        }
        return actions.isServiceRunning(name);
      },
      async openInBrowser(url: string): Promise<void> {
        await openInBrowser(url);
      },
    },
    bindActions(a) {
      actions = a;
    },
  };
}
