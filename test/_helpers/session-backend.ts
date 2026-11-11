import { computeBootSkip } from "#src/config/loader.js";
import type { SessionCreateParams } from "#src/daemon/session.js";
import { TmuxSessionBackend } from "#src/lib/backend/tmux/session.js";
import { tmuxFor } from "#src/lib/tmux.js";

import type { ServiceManagerFixtureDeps } from "./service-runtime.js";
import { managerDependencies } from "./service-runtime.js";

export interface TmuxFixtureParams extends Omit<SessionCreateParams, "backend" | "deps"> {
  tmuxSession: string;
  tmuxWindow: string;
  originPane: string;
  tmuxSocket: string | null;
  managedTmux: boolean;
  deps: ServiceManagerFixtureDeps;
  skip?: Set<string>;
}

export async function createTmuxSession(params: TmuxFixtureParams) {
  const targets: Record<string, string> = {};
  const deps = managerDependencies(targets, params.deps);
  const backend = await TmuxSessionBackend.create({
    host: {
      tmuxSession: params.tmuxSession,
      tmuxWindow: params.tmuxWindow,
      originPane: params.originPane,
      tmuxSocket: params.tmuxSocket,
      managedTmux: params.managedTmux,
    },
    tmux: tmuxFor(params.tmuxSocket),
    runtime: deps.runtime,
    disposeRuntime: async () => {
      if ("dispose" in deps.runtime && typeof deps.runtime.dispose === "function") {
        await deps.runtime.dispose();
      }
    },
    layout: params.config.project.layout,
    services: params.config.project.services,
    groups: params.config.groups,
    skip: params.skip ?? computeBootSkip(params.config),
  });
  const update = () => {
    for (const key of Object.keys(targets)) {
      Reflect.deleteProperty(targets, key);
    }
    const view = backend.getPresentation();
    if (view.kind === "tmux") {
      Object.assign(targets, view.paneMap);
    }
  };
  update();
  backend.subscribePresentation(update);
  return {
    configPath: params.configPath,
    projectDir: params.projectDir,
    config: params.config,
    shellEnv: params.shellEnv,
    env: params.env,
    deps,
    backend,
  };
}
