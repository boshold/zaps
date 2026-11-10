import { ShellSessionBackend } from "#src/lib/backend/shell/session.js";
import type { ShellSessionOptions } from "#src/lib/backend/shell/session.js";
import { TmuxSessionBackend } from "#src/lib/backend/tmux/session.js";
import type { TmuxSessionOptions } from "#src/lib/backend/tmux/session.js";
import type { BackendId, SessionBackend } from "#src/lib/backend/types.js";

interface BackendOptions {
  tmux: TmuxSessionOptions;
  shell: ShellSessionOptions;
}

const backendFactories = Object.freeze({
  tmux: async (options: TmuxSessionOptions) => TmuxSessionBackend.create(options),
  shell: async (options: ShellSessionOptions) => ShellSessionBackend.create(options),
}) satisfies { [K in BackendId]: (options: BackendOptions[K]) => Promise<SessionBackend> };

type SessionBackendOptions = {
  [K in BackendId]: { backend: K; options: BackendOptions[K] };
}[BackendId];

async function createSessionBackend(request: SessionBackendOptions): Promise<SessionBackend> {
  if (request.backend === "tmux") {
    return backendFactories.tmux(request.options);
  }
  return backendFactories.shell(request.options);
}

export { backendFactories, createSessionBackend };
export { preflightBackendCompatibility } from "#src/lib/backend/compatibility.js";
export type { SessionBackendOptions };
