// eslint-disable-next-line import/no-namespace -- the module surface IS the env-based handle; a namespace binding keeps lookups lazy
import * as tmux from "./tmux.js";
import type { TmuxHandle } from "./tmux.js";

/**
 * Handle bound to the socket in `ZAPS_TMUX_SOCKET` (default server when unset),
 * i.e. the module-level exports. Used wherever no socket-bound handle is passed
 * in, so consumers never read the env themselves.
 */
export const defaultTmux: TmuxHandle = tmux;
