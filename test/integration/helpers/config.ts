import os from "node:os";
import path from "node:path";

import type { ResolvedConfig, ServiceConfig, TaskConfig } from "#src/config/types.js";

export function makeConfig(
  services: Record<string, ServiceConfig>,
  opts?: {
    hooks?: ResolvedConfig["project"]["hooks"];
    tasks?: Record<string, TaskConfig>;
  },
): ResolvedConfig {
  // Raw mode default — these tests use ServiceManager directly without a daemon,
  // So wrapper mode (which needs IPC to resolve exec info) would fail.
  const rawServices: Record<string, ServiceConfig> = {};
  for (const [name, svc] of Object.entries(services)) {
    rawServices[name] = { raw: true, ...svc };
  }

  return {
    project: {
      name: "integration-test",
      services: rawServices,
      hooks: opts?.hooks,
      tasks: opts?.tasks,
    },
    configPath: path.join(os.tmpdir(), ".zaps.ts"),
    projectDir: os.tmpdir(),
    groups: new Map(),
    unavailableServices: new Map(),
  };
}
