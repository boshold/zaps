import { computeBootSkip } from "#src/config/loader.js";
import type { SessionCreateParams } from "#src/daemon/session.js";
import { TmuxSessionBackend } from "#src/lib/backend/tmux/session.js";
import { tmuxFor } from "#src/lib/tmux.js";

export interface LegacySessionParams extends Omit<SessionCreateParams, "backend"> {
  tmuxSession: string;
  tmuxWindow: string;
  originPane: string;
  tmuxSocket: string | null;
  managedTmux: boolean;
  paneMap: Record<string, string>;
}

/** Constructor fixture bridge; removed by P06-T04. */
export function prepareSessionParams(params: LegacySessionParams) {
  const backend = TmuxSessionBackend.adopt(
    {
      host: {
        tmuxSession: params.tmuxSession,
        tmuxWindow: params.tmuxWindow,
        originPane: params.originPane,
        tmuxSocket: params.tmuxSocket,
        managedTmux: params.managedTmux,
      },
      tmux: tmuxFor(params.tmuxSocket),
      runtime: params.deps.runtime(params.paneMap),
      layout: params.config.project.layout,
      services: params.config.project.services,
      groups: params.config.groups,
    },
    params.paneMap,
  );
  return {
    ...params,
    backend,
    reloadPresentation: async (config: SessionCreateParams["config"]) =>
      backend.reload(config, computeBootSkip(config)),
    insertPresentation: async (name: string) => backend.insertPane(name),
    removePresentation: async (name: string) => backend.removePane(name),
    updatePresentationTitle: async (statuses: Parameters<typeof backend.updateServiceTitle>[0]) =>
      backend.updateServiceTitle(statuses),
  };
}
