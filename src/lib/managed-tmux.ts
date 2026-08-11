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
  /** The zaps invocation to run in the bootstrap pane, e.g. `["/usr/bin/zaps", "up"]`. */
  zapsArgv: string[];
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
  args.push(
    "-s",
    options.name,
    "-e",
    `ZAPS_TMUX_SOCKET=${MANAGED_SOCKET}`,
    "-e",
    "ZAPS_MANAGED_TMUX=1",
    "--",
    ...options.zapsArgv,
  );
  return args;
}

/** `tmux -L zaps attach-session -t <name>` argv. */
function buildAttachArgs(name: string): string[] {
  return ["-L", MANAGED_SOCKET, "attach-session", "-t", name];
}

/**
 * `tmux -L zaps respawn-pane -t <paneId> -- <zaps argv>` argv. The argv form is
 * mandatory: passing the command as one shell string misbehaved in live testing.
 * `paneId` must be a `%N` pane id — index targeting breaks under `pane-base-index`.
 */
function buildRespawnArgs(paneId: string, zapsArgv: string[]): string[] {
  return ["-L", MANAGED_SOCKET, "respawn-pane", "-t", paneId, "--", ...zapsArgv];
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
  | { settled: false; reason: "timeout" | "gone" };

interface WaitForPaneSettledOptions {
  /** Give up after this long; the caller decides what a timeout means. */
  timeoutMs?: number;
  /** Gap between `pane_dead` probes. */
  pollMs?: number;
  tmux?: ManagedTmux;
}

/**
 * Poll `#{pane_dead}` until the bootstrap pane's command exits, then report the
 * inner exit code from `#{pane_dead_status}` (the pane must have
 * `remain-on-exit on`, else it vanishes and there is nothing left to read).
 * Bounded polling on a real condition — never a fixed sleep.
 */
async function waitForPaneSettled(
  paneId: string,
  options: WaitForPaneSettledOptions = {},
): Promise<PaneSettlement> {
  const { timeoutMs = 60_000, pollMs = 100, tmux = managedTmux() } = options;
  const deadline = Date.now() + timeoutMs;

  /* eslint-disable no-await-in-loop -- sequential polling is the point */
  while (Date.now() < deadline) {
    // Null signals the pane (or its session) disappeared — no exit code will
    // Ever arrive, so stop polling for one.
    const probe = await tmux
      .displayMessage(paneId, "#{pane_dead} #{pane_dead_status}")
      .catch(() => null);
    if (probe === null) {
      return { settled: false, reason: "gone" };
    }
    const [dead, status] = probe.trim().split(/\s+/u);
    if (dead === "1") {
      const exitCode = Number.parseInt(status ?? "", 10);
      return { settled: true, exitCode: Number.isNaN(exitCode) ? 0 : exitCode };
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
