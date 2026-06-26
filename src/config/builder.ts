import { z } from "zod";

import { openInBrowser } from "#src/lib/open.js";

import { ConfigError } from "./errors.js";
import { createCliHelpers, createStderrSink } from "./helpers/cli.js";
import { createFindHelpers } from "./helpers/find.js";
import { nodeModules } from "./node.js";
import { projectConfigSchema } from "./schema.js";
import type { Library, LibraryActions, NoticeSink, ProjectConfig } from "./types.js";

export interface ZapsLib {
  lib: Library;
  bindActions: (actions: LibraryActions) => void;
}

export function createZapsLib(opts?: { onNotice?: NoticeSink }): ZapsLib {
  let actions: LibraryActions | null = null;
  const sink = opts?.onNotice ?? createStderrSink();

  return {
    lib: {
      define(config: ProjectConfig): ProjectConfig {
        try {
          return projectConfigSchema.parse(config);
        } catch (error) {
          if (error instanceof z.ZodError) {
            const message = error.issues
              .map((i) => {
                const path = i.path.length ? `${i.path.join(".")}: ` : "";
                return `${path}${i.message}`;
              })
              .join("\n");
            const firstPath = error.issues[0]?.path;
            const field = firstPath?.length ? firstPath.join(".") : undefined;
            throw new ConfigError(message, { kind: "validation", field });
          }
          throw error;
        }
      },
      find: createFindHelpers(),
      cli: createCliHelpers(sink),
      task: {
        async run(key: string): Promise<void> {
          if (!actions) {
            throw new Error("task.run is not available outside of service hooks");
          }
          await actions.runTask(key);
        },
      },
      service: {
        async start(name: string): Promise<void> {
          if (!actions) {
            throw new Error("service.start is not available outside of service hooks");
          }
          await actions.startService(name);
        },
        async stop(name: string): Promise<void> {
          if (!actions) {
            throw new Error("service.stop is not available outside of service hooks");
          }
          await actions.stopService(name);
        },
        async restart(name: string): Promise<void> {
          if (!actions) {
            throw new Error("service.restart is not available outside of service hooks");
          }
          await actions.restartService(name);
        },
        isRunning(name: string): boolean {
          if (!actions) {
            throw new Error("service.isRunning is not available outside of service hooks");
          }
          return actions.isServiceRunning(name);
        },
      },
      browser: {
        async open(url: string): Promise<void> {
          await openInBrowser(url);
        },
      },
      node: nodeModules,
    },
    bindActions(a) {
      actions = a;
    },
  };
}
