import { MANAGED_SOCKET } from "#src/lib/managed-tmux.js";
import type { TmuxAvailability } from "#src/lib/managed-tmux.js";

/** Where tmux install instructions live (F8). */
const TMUX_INSTALL_URL = "https://github.com/tmux/tmux/wiki/Installing";

/** The pre-auto-tmux error, still used by the `ZAPS_AUTO_TMUX=0` escape hatch. */
const LEGACY_TMUX_ERROR = "zaps must be run from inside a tmux session.";

/** The daemon's view of this project's session, as far as the bootstrap cares. */
interface DaemonSessionView {
  name: string;
  /** Tmux session hosting it — the managed name, or a personal tmux session. */
  tmuxSession: string;
  /** True when zaps owns the hosting tmux session. */
  managed: boolean;
}

interface TmuxContextInput {
  /** `$TMUX` — set exactly when we already run inside some tmux. */
  tmuxEnv: string | undefined;
  /** `ZAPS_AUTO_TMUX`; `"0"` restores the pre-auto-tmux error. */
  autoTmuxEnv: string | undefined;
  /** True for `zaps up -d` — the headless create path (F4). */
  detach: boolean;
  /** Tmux presence + version gate; only consulted outside tmux. */
  tmuxAvailability: TmuxAvailability;
  /** Live session for this project, or undefined when the daemon has none. */
  daemonSession: DaemonSessionView | undefined;
  /** Managed session name for this project (`zaps-<project>-<id>`). */
  managedName: string;
  /** True when `managedName` exists on the managed socket. */
  managedSessionExists: boolean;
}

/**
 * What the CLI should do about its tmux context. Every branch of the F1/F4/F8/F9
 * decision flow lands on exactly one of these; refusals and errors carry their
 * user-facing text so the caller only has to print and exit.
 */
type TmuxContextDecision =
  | { kind: "proceed-inside" }
  | { kind: "spawn"; name: string }
  | { kind: "spawn-detached"; name: string }
  | { kind: "kill-stale-then-spawn"; name: string; detach: boolean }
  | { kind: "reattach"; name: string }
  | { kind: "already-running"; message: string }
  | { kind: "refuse-personal"; message: string }
  | { kind: "refuse-managed"; message: string }
  | { kind: "error-no-tmux"; message: string }
  | { kind: "error-legacy"; message: string };

/** F8 — one message for both "not installed" and "too old", per 50_api. */
function noTmuxMessage(availability: TmuxAvailability): string {
  const base = `zaps requires tmux (>= 3.5a) — install it and re-run.`;
  const found =
    !availability.ok && availability.reason === "too-old"
      ? ` Found tmux ${availability.version}.`
      : "";
  return `${base}${found} ${TMUX_INSTALL_URL}`;
}

/** `up -d` against an already-running managed session: report, don't re-create. */
function alreadyRunningMessage(session: DaemonSessionView): string {
  return `Session "${session.name}" is already running (managed tmux). zaps attach to view.`;
}

/** F6 — the session lives in the user's own tmux; only reachable from there. */
function refusePersonalMessage(session: DaemonSessionView): string {
  return `Session "${session.name}" is running inside tmux session '${session.tmuxSession}'. Attach from within tmux, or run zaps down first.`;
}

/** F7 — the session lives in a managed tmux; re-attach from a plain terminal. */
function refuseManagedMessage(session: DaemonSessionView): string {
  return [
    `Session "${session.name}" is running in a zaps-managed tmux. Re-attach from a plain terminal (zaps attach), or run zaps down first.`,
    `  tmux -L ${MANAGED_SOCKET} attach -t ${session.tmuxSession}`,
  ].join("\n");
}

/**
 * Pure decision flow for `zaps` / `zaps up` (10_functional "Decision Flow").
 *
 * Inside tmux nothing changes unless the project's session is managed (F7).
 * Outside tmux the escape hatch wins first, then the tmux gate (F8), then any
 * conflicting or reusable session (F6/F3), then staleness (F9), and finally the
 * plain create path (F1/F4).
 */
function decideTmuxContext(input: TmuxContextInput): TmuxContextDecision {
  if (input.tmuxEnv) {
    // Already inside tmux: today's behavior, except a managed session can only
    // Be driven from a plain terminal (F7).
    if (input.daemonSession?.managed) {
      return { kind: "refuse-managed", message: refuseManagedMessage(input.daemonSession) };
    }
    return { kind: "proceed-inside" };
  }

  if (input.autoTmuxEnv === "0") {
    return { kind: "error-legacy", message: LEGACY_TMUX_ERROR };
  }

  if (!input.tmuxAvailability.ok) {
    return { kind: "error-no-tmux", message: noTmuxMessage(input.tmuxAvailability) };
  }

  if (input.daemonSession) {
    // A live session the daemon knows about: anything not managed lives in a
    // Tmux we must not touch (F6).
    if (!input.daemonSession.managed) {
      return { kind: "refuse-personal", message: refusePersonalMessage(input.daemonSession) };
    }
    // Managed and already up: `-d` has nothing left to do (and no TTY to attach
    // With), everything else re-enters it (F3).
    return input.detach
      ? { kind: "already-running", message: alreadyRunningMessage(input.daemonSession) }
      : { kind: "reattach", name: input.daemonSession.tmuxSession };
  }

  if (input.managedSessionExists) {
    // Name taken on the zaps socket with no daemon session behind it — a stale
    // Leftover from a crashed daemon (F9). Ours to reap, then create fresh.
    return { kind: "kill-stale-then-spawn", name: input.managedName, detach: input.detach };
  }

  return input.detach
    ? { kind: "spawn-detached", name: input.managedName }
    : { kind: "spawn", name: input.managedName };
}

export { LEGACY_TMUX_ERROR, TMUX_INSTALL_URL, decideTmuxContext };
export type { DaemonSessionView, TmuxContextDecision, TmuxContextInput };
