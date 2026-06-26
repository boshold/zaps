import fs from "node:fs";
import path from "node:path";

import { ConfigError } from "#src/config/errors.js";
import type { CwdContext, CwdResolver, FindHelpers, FindUpOptions } from "#src/config/types.js";

/** Defensive cap so a pathological filesystem can't loop the walk unboundedly. */
const MAX_WALK_DEPTH = 256;

/** Resolve the walk boundary: a static path, the configDir, or none (root). */
function resolveBoundary(stopAt: FindUpOptions["stopAt"], configDir: string): string | null {
  if (stopAt === undefined) {
    return null;
  }
  return stopAt === "config" ? path.resolve(configDir) : path.resolve(stopAt);
}

/**
 * `find.up(filename, opts?)` returns a `CwdResolver` that walks upward from
 * `ctx.invokeDir` looking for a directory containing `filename`. The walk is
 * bounded by `opts.stopAt` (a static path or `"config"` → `ctx.configDir`),
 * else the filesystem root. On not-found it throws `ConfigError` (`notFound`)
 * — it never returns null, so it assigns directly to the `cwd` field.
 */
export function createFindHelpers(): FindHelpers {
  const up =
    (filename: string, opts: FindUpOptions = {}): CwdResolver =>
    (ctx: CwdContext): string => {
      const boundary = resolveBoundary(opts.stopAt, ctx.configDir);
      let dir = path.resolve(ctx.invokeDir);

      for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
        if (fs.existsSync(path.join(dir, filename))) {
          return dir;
        }
        if (boundary !== null && dir === boundary) {
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
          break;
        }
        dir = parent;
      }

      throw new ConfigError(
        opts.orFatal ?? `${filename} not found walking up from ${ctx.invokeDir}`,
        {
          kind: "notFound",
          field: "cwd",
        },
      );
    };

  return { up };
}
