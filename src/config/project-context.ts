import fs from "node:fs";
import path from "node:path";

import { resolveEnvironment, runWithEnvironment } from "#src/lib/request-context.js";

import { createStderrSink } from "./helpers/cli.js";
import { loadConfig } from "./loader.js";
import type { ConfigNotice, NoticeSink, ResolvedConfig } from "./types.js";

export interface ResolvedProjectContext {
  config: ResolvedConfig;
  env: Record<string, string>;
}

export async function loadProjectContext(
  configPath: string,
  invokeDir: string,
  shellEnv: Record<string, string>,
  onNotice?: NoticeSink,
): Promise<ResolvedProjectContext> {
  const notices: ConfigNotice[] = [];
  const probe = await runWithEnvironment(shellEnv, async () =>
    loadConfig(configPath, invokeDir, (notice) => notices.push(notice)),
  );
  if (typeof fs.existsSync !== "function" || !fs.existsSync(path.join(probe.projectDir, ".env"))) {
    const sink = onNotice ?? createStderrSink();
    for (const notice of notices) {
      sink(notice);
    }
    return { config: probe, env: { ...shellEnv } };
  }
  const env = resolveEnvironment(probe.projectDir, shellEnv);
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
