import { tmuxFor } from "./tmux.js";
import type { TmuxHandle } from "./tmux.js";

/** Socket of the tmux server zaps owns. The user's own server is never touched. */
const MANAGED_SOCKET = "zaps";

/** Oldest tmux zaps supports (3.5a — the letter suffix is not part of the check). */
const MIN_TMUX_VERSION = { major: 3, minor: 5 } as const;

/** Longest sanitized project-name segment in a managed session name. */
const MAX_NAME_SEGMENT = 30;

/** The tmux commands this module issues, always on {@link MANAGED_SOCKET}. */
type ManagedTmux = Pick<
  TmuxHandle,
  "displayMessage" | "hasSession" | "killSession" | "tmuxVersion"
>;

/** Handle bound to the managed socket — never the env, never the default server. */
function managedTmux(): ManagedTmux {
  return tmuxFor(MANAGED_SOCKET);
}

/**
 * Reduce a project name to the character set tmux accepts in a session name.
 * tmux rejects `.` and `:` outright (they address windows/panes), so everything
 * outside `[a-zA-Z0-9_-]` collapses to a single `-`. Lowercased and truncated so
 * the name stays readable in `tmux ls`; an all-invalid name falls back to
 * `project` rather than producing an empty segment.
 */
function sanitizeProjectName(projectName: string): string {
  const sanitized = projectName
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, "-")
    .replaceAll(/-{2,}/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "")
    .slice(0, MAX_NAME_SEGMENT)
    .replace(/-+$/u, "");
  return sanitized || "project";
}

/**
 * Deterministic managed session name: `zaps-<sanitized>-<sessionId>`. The
 * `sessionId` (sha256 of the config path) keeps the name ↔ zaps session mapping
 * 1:1, so two projects sharing a display name never collide.
 */
function managedSessionName(projectName: string, sessionIdValue: string): string {
  return `zaps-${sanitizeProjectName(projectName)}-${sessionIdValue}`;
}

/** True when `name` exists on the managed server. */
async function hasManagedSession(
  name: string,
  tmux: ManagedTmux = managedTmux(),
): Promise<boolean> {
  return tmux.hasSession(name);
}

/**
 * Kill a managed session the daemon no longer knows about (F9). Callers MUST
 * confirm via `session.list` that no live zaps session maps to `name` first —
 * this only guarantees the target lives in the zaps-owned namespace on the
 * zaps-owned socket. Returns true when a session was actually killed.
 */
async function killStaleSession(name: string, tmux: ManagedTmux = managedTmux()): Promise<boolean> {
  try {
    await tmux.killSession(name);
    return true;
  } catch {
    // Already gone (or never existed) — the post-condition holds either way.
    return false;
  }
}

/** Result of the tmux presence + version gate; `reason` drives the F8 message. */
type TmuxAvailability =
  | { ok: true; version: string }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "too-old"; version: string };

/** Tmux on PATH and new enough (>= {@link MIN_TMUX_VERSION}) to host a managed session. */
async function tmuxAvailable(tmux: ManagedTmux = managedTmux()): Promise<TmuxAvailability> {
  const version = await tmux.tmuxVersion();
  if (!version) {
    return { ok: false, reason: "missing" };
  }
  const label = `${version.major}.${version.minor}`;
  const tooOld =
    version.major < MIN_TMUX_VERSION.major ||
    (version.major === MIN_TMUX_VERSION.major && version.minor < MIN_TMUX_VERSION.minor);
  return tooOld ? { ok: false, reason: "too-old", version: label } : { ok: true, version: label };
}

interface CreateArgsOptions {
  /** Managed session name from {@link managedSessionName}. */
  name: string;
  /** `-d`: create without attaching (the `up -d` path). */
  detach?: boolean;
  /**
   * The zaps invocation for the bootstrap pane, e.g. `["/usr/bin/zaps", "up"]`.
   * Omit to start the default shell — used by the detached path, which sets the
   * pane options first and only then respawns the pane with the real command.
   */
  zapsArgv?: string[];
  /**
   * Extra `-e` session env on top of the two markers. Used to forward the
   * daemon-locating vars so the inner zaps talks to the same daemon the outer
   * one just consulted — a session created with `-e` does not inherit them from
   * a tmux server that may long predate this process.
   */
  env?: Record<string, string>;
  /** `-x`/`-y`: initial size, so panes are laid out at the real terminal size. */
  width?: number;
  height?: number;
}

/**
 * `tmux -L zaps new-session …` argv. The two `-e` markers are what the inner
 * zaps reads to route its tmux calls and to report `managedTmux` on create.
 */
function buildCreateArgs(options: CreateArgsOptions): string[] {
  const args = ["-L", MANAGED_SOCKET, "new-session"];
  if (options.detach) {
    args.push("-d");
  }
  if (options.width && options.height) {
    args.push("-x", String(options.width), "-y", String(options.height));
  }
  args.push(
    "-s",
    options.name,
    "-e",
    `ZAPS_TMUX_SOCKET=${MANAGED_SOCKET}`,
    "-e",
    "ZAPS_MANAGED_TMUX=1",
  );
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  if (options.zapsArgv?.length) {
    args.push("--", ...options.zapsArgv);
  }
  return args;
}

/** `tmux -L zaps attach-session -t <name>` argv. */
function buildAttachArgs(name: string): string[] {
  return ["-L", MANAGED_SOCKET, "attach-session", "-t", name];
}

/**
 * `tmux -L zaps respawn-pane [-k] -t <paneId> -- <zaps argv>` argv. The argv form
 * is mandatory: passing the command as one shell string misbehaved in live
 * testing. `paneId` must be a `%N` pane id — index targeting breaks under
 * `pane-base-index`. Pass `kill` when the pane is still ALIVE (bootstrap: the
 * placeholder shell); tmux refuses to respawn a live pane without `-k`.
 */
function buildRespawnArgs(
  paneId: string,
  zapsArgv: string[],
  options: { kill?: boolean } = {},
): string[] {
  const args = ["-L", MANAGED_SOCKET, "respawn-pane"];
  if (options.kill) {
    args.push("-k");
  }
  args.push("-t", paneId, "--", ...zapsArgv);
  return args;
}

/**
 * `tmux -L zaps new-window -t <name> -- <zaps argv>` argv. Fallback for the
 * re-attach path when the TUI pane is gone entirely (user killed it by hand):
 * a fresh window running `zaps attach` beats failing the command outright.
 */
function buildNewWindowArgs(name: string, zapsArgv: string[]): string[] {
  return ["-L", MANAGED_SOCKET, "new-window", "-t", name, "--", ...zapsArgv];
}

/**
 * `tmux -L zaps set-option -t <name> <option> <value>` argv. Used at create for
 * `destroy-unattached off`, which stops exotic user configs from killing the
 * session (and its services) the moment the client detaches.
 */
function buildSetSessionOptionArgs(name: string, option: string, value: string): string[] {
  return ["-L", MANAGED_SOCKET, "set-option", "-t", name, option, value];
}

/**
 * `tmux -L zaps set-option -p -t <paneId> <option> <value>` argv. Pane-level
 * (`-p`) so it wins over a global user setting — used for `remain-on-exit on`
 * on the TUI pane, which holds the dead pane for re-attach revival.
 */
function buildSetPaneOptionArgs(paneId: string, option: string, value: string): string[] {
  return ["-L", MANAGED_SOCKET, "set-option", "-p", "-t", paneId, option, value];
}

/** Outcome of {@link waitForPaneSettled}. */
type PaneSettlement =
  | { settled: true; exitCode: number }
  | { settled: false; reason: "timeout" | "gone" | "unknown-status" };

interface WaitForPaneSettledOptions {
  /** Give up after this long; the caller decides what a timeout means. */
  timeoutMs?: number;
  /** Gap between `pane_dead` probes. */
  pollMs?: number;
  tmux?: ManagedTmux;
}

/** Probe format: `|`-joined so an empty field survives the split. */
const SETTLE_FORMAT = "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}";

/** Consecutive probe errors tolerated before declaring the pane gone. */
const MAX_PROBE_ERRORS = 3;

/**
 * Poll `#{pane_dead}` until the bootstrap pane's command exits, then report the
 * inner exit code from `#{pane_dead_status}` (the pane must have
 * `remain-on-exit on`, else it vanishes and there is nothing left to read).
 * Bounded polling on a real condition — never a fixed sleep.
 *
 * A dead pane with no readable status is NEVER reported as exit 0: a pane killed
 * by a signal exposes `#{pane_dead_signal}` instead, which maps to the usual
 * `128 + signal`, and anything still unreadable settles as `unknown-status` so a
 * SIGKILLed run can't be mistaken for success.
 */
async function waitForPaneSettled(
  paneId: string,
  options: WaitForPaneSettledOptions = {},
): Promise<PaneSettlement> {
  const { timeoutMs = 60_000, pollMs = 100, tmux = managedTmux() } = options;
  const deadline = Date.now() + timeoutMs;
  let probeErrors = 0;

  /* eslint-disable no-await-in-loop -- sequential polling is the point */
  while (Date.now() < deadline) {
    // Null means this probe failed; only a RUN of failures means the pane (or
    // Its session) is really gone — a single transient tmux error must not end
    // The wait.
    const probe = await tmux.displayMessage(paneId, SETTLE_FORMAT).catch(() => null);
    if (probe === null) {
      probeErrors += 1;
      if (probeErrors >= MAX_PROBE_ERRORS) {
        return { settled: false, reason: "gone" };
      }
    } else {
      probeErrors = 0;
      const [dead, status, signal] = probe.trim().split("|");
      if (dead === "1") {
        const exitCode = Number.parseInt(status ?? "", 10);
        if (!Number.isNaN(exitCode)) {
          return { settled: true, exitCode };
        }
        const deadSignal = Number.parseInt(signal ?? "", 10);
        if (!Number.isNaN(deadSignal)) {
          return { settled: true, exitCode: 128 + deadSignal };
        }
        return { settled: false, reason: "unknown-status" };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  /* eslint-enable no-await-in-loop */

  return { settled: false, reason: "timeout" };
}

export {
  MANAGED_SOCKET,
  MIN_TMUX_VERSION,
  buildAttachArgs,
  buildCreateArgs,
  buildNewWindowArgs,
  buildRespawnArgs,
  buildSetPaneOptionArgs,
  buildSetSessionOptionArgs,
  hasManagedSession,
  killStaleSession,
  managedSessionName,
  managedTmux,
  sanitizeProjectName,
  tmuxAvailable,
  waitForPaneSettled,
};
export type { CreateArgsOptions, PaneSettlement, TmuxAvailability, WaitForPaneSettledOptions };
