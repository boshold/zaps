import path from "node:path";

import { resolveEnvironment, runWithEnvironment } from "#src/lib/request-context.js";

import { createStderrSink } from "./helpers/cli.js";
import { loadConfig } from "./loader.js";
import type { ConfigNotice, NoticeSink, ResolvedConfig } from "./types.js";

interface ResolvedProjectContext {
  config: ResolvedConfig;
  env: Record<string, string>;
}

function environmentsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([key, value]) => right[key] === value)
  );
}

export async function loadProjectContext(
  configPath: string,
  invokeDir: string,
  shellEnv: Record<string, string>,
  onNotice?: NoticeSink,
): Promise<ResolvedProjectContext> {
  const notices: ConfigNotice[] = [];
  const invokeEnv = resolveEnvironment(invokeDir, shellEnv);
  const probe = await runWithEnvironment(invokeEnv, async () =>
    loadConfig(configPath, invokeDir, (notice) => notices.push(notice)),
  );
  const env = resolveEnvironment(probe.projectDir, shellEnv);
  if (environmentsEqual(invokeEnv, env)) {
    const sink = onNotice ?? createStderrSink();
    for (const notice of notices) {
      sink(notice);
    }
    return { config: probe, env };
  }
  const config = await runWithEnvironment(env, async () =>
    loadConfig(configPath, invokeDir, onNotice),
  );
  if (path.resolve(config.projectDir) !== path.resolve(probe.projectDir)) {
    throw new Error(
      `Project cwd changed after loading ${path.join(probe.projectDir, ".env")}. ` +
        "Project cwd cannot depend on values from its own .env file.",
    );
  }
  return { config, env };
}

export type { ResolvedProjectContext };
