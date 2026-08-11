import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { getEnv } from "./env.js";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimum pause (ms) for tmux's event loop to process a resize and push the new
 *  pty winsize before the next command. Measured threshold ~100ms; 150 for margin. */
const RESYNC_SETTLE_MS = 150;

interface PaneInfo {
  id: string;
  pid: number;
  width: number;
  height: number;
  /** `#{pane_dead}` — true for a pane held open by `remain-on-exit`. */
  dead: boolean;
}

interface SplitPaneOptions {
  /** Percentage of the parent pane the new pane should occupy. */
  percent?: number;
  /** When true, pass `-d` so the new pane does NOT steal focus from the active pane. */
  detached?: boolean;
  /** When true, pass `-b` so the new pane is inserted *before* `target` in spatial order. */
  before?: boolean;
}

/**
 * Force EXACT session-name matching (`-t =name`).
 *
 * tmux resolves a target-session as exact → prefix → fnmatch, so `kill-session
 * -t zaps-app-a1` happily kills `zaps-app-a1-notes` when the exact name is gone
 * — and `has-session` reports the short name as existing. Every session-name
 * target zaps sends goes through here; pane targets (`%N`) are unambiguous and
 * are left alone.
 */
function exact(sessionName: string): string {
  return `=${sessionName}`;
}

/**
 * Exact target for the session's CURRENT WINDOW (`=name:`).
 *
 * Window-scoped commands (`display-message`, `select-layout`, `resize-window`,
 * `set-option`) need the trailing colon: verified live, a bare `=name` makes
 * `display-message` return an empty string and `select-layout` fail outright,
 * while a bare `name` prefix-matches a longer-named session exactly like the
 * session-target commands do.
 */
function exactWindowTarget(sessionName: string): string {
  return `=${sessionName}:`;
}

interface DisplayPopupOptions {
  cwd?: string;
  command: string;
  title?: string;
  width?: string;
  height?: string;
  env?: Record<string, string>;
}

/**
 * Build the whole tmux command surface bound to one tmux server socket.
 * `resolveSocket` is called per command so the env-based default handle picks up
 * `ZAPS_TMUX_SOCKET` changes at call time (as the previous module-level
 * `socketArgs()` did).
 */
function createTmux(resolveSocket: () => string | null) {
  function socketArgs(): string[] {
    const socket = resolveSocket();
    return socket ? ["-L", socket] : [];
  }

  async function run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("tmux", [...socketArgs(), ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => (stdout += d));
      proc.stderr.on("data", (d: Buffer) => (stderr += d));
      // Without this the spawn failure (no tmux on PATH → ENOENT) surfaces as an
      // Unhandled 'error' event and takes the whole process down, so callers'
      // Try/catch — including the tmux-presence gate — never runs.
      proc.on("error", reject);
      proc.on("close", (code: number | null) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`tmux ${args.join(" ")} failed: ${stderr.trim()}`));
        }
      });
    });
  }

  async function currentPaneId(): Promise<string> {
    return run(["display-message", "-p", "#{pane_id}"]);
  }

  /**
   * Raw `display-message -p -t <target> <format>` for format strings the typed
   * helpers don't cover (e.g. `#{pane_dead}`/`#{pane_dead_status}`).
   */
  async function displayMessage(target: string, format: string): Promise<string> {
    return run(["display-message", "-p", "-t", target, format]);
  }

  async function currentSession(): Promise<string> {
    return run(["display-message", "-p", "#{session_name}"]);
  }

  async function showEnv(session: string, key: string): Promise<string | null> {
    try {
      const out = await run(["show-environment", "-t", exact(session), key]);
      return out.replace(`${key}=`, "");
    } catch {
      return null;
    }
  }

  async function listPanes(session: string, allWindows = false): Promise<PaneInfo[]> {
    const args = ["list-panes"];
    if (allWindows) {
      args.push("-s");
    }
    args.push(
      "-t",
      exact(session),
      "-F",
      "#{pane_id}:#{pane_pid}:#{pane_width}:#{pane_height}:#{pane_dead}",
    );
    const out = await run(args);
    if (!out) {
      return [];
    }
    return out.split("\n").map((line) => {
      const [id, pid, width, height, dead] = line.split(":");
      return {
        id,
        pid: Number.parseInt(pid, 10),
        width: Number.parseInt(width, 10),
        height: Number.parseInt(height, 10),
        dead: dead === "1",
      };
    });
  }

  async function hasSession(name: string): Promise<boolean> {
    try {
      await run(["has-session", "-t", exact(name)]);
      return true;
    } catch {
      return false;
    }
  }

  async function sendKeys(target: string, keys: string): Promise<void> {
    await run(["send-keys", "-t", target, "-l", keys]);
    await run(["send-keys", "-t", target, "Enter"]);
  }

  async function newSession(name: string, opts?: { x?: number; y?: number }): Promise<string> {
    const args = ["new-session", "-d", "-s", name];
    if (opts?.x) {
      args.push("-x", String(opts.x));
    }
    if (opts?.y) {
      args.push("-y", String(opts.y));
    }
    args.push("-P", "-F", "#{pane_id}");
    return run(args);
  }

  async function newWindow(session: string): Promise<string> {
    return run(["new-window", "-t", exact(session), "-d", "-P", "-F", "#{pane_id}"]);
  }

  async function killSession(name: string): Promise<void> {
    await run(["kill-session", "-t", exact(name)]);
  }

  async function splitPane(
    target: string,
    direction: "h" | "v",
    options?: SplitPaneOptions,
  ): Promise<string> {
    const args = ["split-window", `-${direction}`];
    if (options?.before) {
      args.push("-b");
    }
    if (options?.detached) {
      args.push("-d");
    }
    args.push("-t", target);
    if (typeof options?.percent === "number") {
      args.push("-l", `${options.percent}%`);
    }
    args.push("-P", "-F", "#{pane_id}");
    return run(args);
  }

  /** Swap two panes' positions (`swap-pane -s <src> -t <dst>`). Processes stay attached. */
  async function swapPanes(src: string, dst: string): Promise<void> {
    await run(["swap-pane", "-s", src, "-t", dst]);
  }

  /**
   * Apply an absolute layout string to `target`'s window via `select-layout -t <target> <layout>`.
   * `layout` is passed as a single argv element so the `{` / `[` characters never hit a shell —
   * `run` already spawns tmux directly without one.
   */
  async function selectLayout(target: string, layout: string): Promise<void> {
    await run(["select-layout", "-t", target, layout]);
  }

  /** Read the live `#{window_layout}` string for `target`'s window (for tests/rollback). */
  async function windowLayout(target: string): Promise<string> {
    return run(["display-message", "-p", "-t", target, "#{window_layout}"]);
  }

  /**
   * The current spatial order of panes in `target`'s window, sorted by `pane_index`.
   * tmux assigns `pane_index` in spatial DFS order, so this is exactly the order
   * `select-layout` binds panes to layout cells.
   */
  async function paneIndexOrder(target: string): Promise<{ index: number; id: string }[]> {
    const out = await run(["list-panes", "-t", target, "-F", "#{pane_index} #{pane_id}"]);
    if (!out) {
      return [];
    }
    return out
      .split("\n")
      .map((line) => {
        const [indexStr, id] = line.split(" ");
        return { index: Number.parseInt(indexStr, 10), id };
      })
      .toSorted((a, b) => a.index - b.index);
  }

  async function killPane(target: string): Promise<void> {
    await run(["kill-pane", "-t", target]);
  }

  /**
   * Detach the client this process is running under. No `-t`: that flag takes a
   * target-CLIENT (a tty name, e.g. `/dev/pts/3`) — passing a pane id fails with
   * `can't find client: %N`. Without it tmux resolves the current client from
   * the caller's `$TMUX`, which is exactly the client to drop.
   *
   * Used by the TUI's managed-mode quit: the user lands back in the plain shell
   * they started from while the session (and its services) live on.
   */
  async function detachClient(): Promise<void> {
    await run(["detach-client"]);
  }

  async function panePid(target: string): Promise<number> {
    const out = await run(["display-message", "-p", "-t", target, "#{pane_pid}"]);
    return Number.parseInt(out, 10);
  }

  /** True if `target` is still a live tmux pane (false if it was killed/closed). */
  async function paneExists(target: string): Promise<boolean> {
    try {
      // A `display-message -t <id>` probe is NOT reliable: tmux exits 0 and echoes
      // The requested id back even for a dead pane whose session is gone, so it
      // Reports every pane as alive (the A4 staleness regression). Enumerate the
      // Live panes across the server instead and check real membership.
      const out = await run(["list-panes", "-a", "-F", "#{pane_id}"]);
      return out.split("\n").includes(target);
    } catch {
      return false;
    }
  }

  async function capturePane(target: string, lines = 100): Promise<string> {
    return run(["capture-pane", "-t", target, "-p", "-S", `-${lines}`]);
  }

  async function sendCtrlC(target: string): Promise<void> {
    await run(["send-keys", "-t", target, "C-c"]);
  }

  async function setEnv(session: string, key: string, value: string): Promise<void> {
    await run(["set-environment", "-t", exact(session), key, value]);
  }

  async function removeEnv(session: string, key: string): Promise<void> {
    await run(["set-environment", "-u", "-t", exact(session), key]);
  }

  async function selectPane(target: string): Promise<void> {
    await run(["select-pane", "-t", target]);
  }

  async function zoomPane(target: string): Promise<void> {
    await run(["select-pane", "-t", target]);
    await run(["resize-pane", "-Z", "-t", target]);
  }

  async function getWindowName(target: string): Promise<string> {
    return run(["display-message", "-p", "-t", target, "#{window_name}"]);
  }

  async function renameWindow(target: string, name: string): Promise<void> {
    await run(["rename-window", "-t", target, name]);
  }

  async function getWindowOption(target: string, option: string): Promise<string> {
    return run(["show-window-option", "-v", "-t", target, option]);
  }

  async function setWindowOption(target: string, option: string, value: string): Promise<void> {
    await run(["set-window-option", "-t", target, option, value]);
  }

  async function getWindowSize(target: string): Promise<{ width: number; height: number }> {
    const out = await run([
      "display-message",
      "-p",
      "-t",
      target,
      "#{window_width} #{window_height}",
    ]);
    const [width, height] = out.split(" ").map((n) => Number.parseInt(n, 10));
    return { width, height };
  }

  async function resizeWindow(target: string, x: number, y: number): Promise<void> {
    await run(["resize-window", "-t", target, "-x", String(x), "-y", String(y)]);
  }

  /**
   * Force tmux to re-push every pane's kernel pty winsize in `target`'s window.
   *
   * Building the layout splits panes repeatedly off the @tui pane; tmux can leave
   * a *split-from* pane's pty winsize stale at its larger pre-split size (verified
   * live: a 152-col pane whose pty still reported 255 cols). The in-process TUI
   * then paints to the stale width and wraps into garbage until a manual resize.
   * tmux only re-pushes a winsize when a pane's size genuinely changes AND once
   * its event loop has processed that change — so nudge the whole window smaller,
   * let it settle, restore it, settle again. `window-size manual` makes the resize
   * stick despite the attached client; the prior option is restored afterwards.
   * Best-effort: any failure is swallowed so it can never block session startup.
   */
  async function resyncPaneSizes(target: string, settleMs = RESYNC_SETTLE_MS): Promise<void> {
    try {
      const { width, height } = await getWindowSize(target);
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return;
      }
      const prevOption = await getWindowOption(target, "window-size");
      await setWindowOption(target, "window-size", "manual");
      await resizeWindow(target, Math.max(width - 10, 20), Math.max(height - 2, 5));
      await sleep(settleMs);
      await resizeWindow(target, width, height);
      await sleep(settleMs);
      await setWindowOption(target, "window-size", prevOption || "latest");
    } catch {
      // Resync is best-effort; never let it block startup.
    }
  }

  /**
   * Parsed tmux version (major.minor), or null if tmux is absent or its version
   * string is unrecognised. `display-popup` (used by the popup task picker) was
   * added in tmux 3.2, so callers gate popups on this.
   */
  async function tmuxVersion(): Promise<{ major: number; minor: number } | null> {
    try {
      const out = await run(["-V"]);
      const match = /(?<major>\d+)\.(?<minor>\d+)/u.exec(out);
      if (!match?.groups) {
        return null;
      }
      return {
        major: Number.parseInt(match.groups.major, 10),
        minor: Number.parseInt(match.groups.minor, 10),
      };
    } catch {
      return null;
    }
  }

  /** True if this tmux supports `display-popup` (>= 3.2). */
  async function tmuxSupportsPopup(): Promise<boolean> {
    const version = await tmuxVersion();
    if (!version) {
      return false;
    }
    return version.major > 3 || (version.major === 3 && version.minor >= 2);
  }

  async function displayPopup(opts: DisplayPopupOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ["display-popup", "-EE"];
      if (opts.cwd) {
        args.push("-d", opts.cwd);
      }
      if (opts.width) {
        args.push("-w", opts.width);
      }
      if (opts.height) {
        args.push("-h", opts.height);
      }
      if (opts.title) {
        args.push("-T", opts.title);
      }
      if (opts.env) {
        for (const [k, v] of Object.entries(opts.env)) {
          args.push("-e", `${k}=${v}`);
        }
      }
      args.push("--", opts.command);

      const proc = spawn("tmux", [...socketArgs(), ...args], { stdio: "ignore" });
      // Same reason as in `run()`: an unhandled 'error' event would crash the
      // Process instead of rejecting this promise.
      proc.on("error", reject);
      proc.on("close", (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Popup command failed with code ${code}`));
        }
      });
    });
  }

  async function editPaneCapture(target: string, title: string): Promise<void> {
    const editor = getEnv("EDITOR") || "vim";
    const template = path.join(os.tmpdir(), "zaps-capture-XXXXXX");
    await displayPopup({
      command: `sh -c 'f=$(mktemp ${template}) && tmux capture-pane -t ${target} -p -S - > "$f" && ${editor} "$f"; rm -f "$f"'`,
      title,
      width: "90%",
      height: "90%",
    });
  }

  return {
    capturePane,
    currentPaneId,
    currentSession,
    detachClient,
    displayMessage,
    displayPopup,
    editPaneCapture,
    getWindowName,
    getWindowOption,
    getWindowSize,
    hasSession,
    killPane,
    killSession,
    listPanes,
    newSession,
    newWindow,
    paneExists,
    paneIndexOrder,
    panePid,
    removeEnv,
    renameWindow,
    resizeWindow,
    resyncPaneSizes,
    selectLayout,
    selectPane,
    sendCtrlC,
    sendKeys,
    setEnv,
    setWindowOption,
    showEnv,
    splitPane,
    swapPanes,
    tmuxSupportsPopup,
    tmuxVersion,
    windowLayout,
    zoomPane,
  };
}

/**
 * A tmux command surface bound to one server socket: `tmuxFor("zaps")` runs
 * `tmux -L zaps …`, `tmuxFor(null)` targets the default server (no `-L`).
 */
function tmuxFor(socket: string | null) {
  return createTmux(() => socket);
}

type TmuxHandle = ReturnType<typeof tmuxFor>;

/** Default handle: socket from `ZAPS_TMUX_SOCKET`, re-read on every command. */
const defaultTmux = createTmux(() => getEnv("ZAPS_TMUX_SOCKET") ?? null);

export type { DisplayPopupOptions, PaneInfo, SplitPaneOptions, TmuxHandle };
export { exactWindowTarget, tmuxFor };
export const {
  capturePane,
  currentPaneId,
  currentSession,
  detachClient,
  displayMessage,
  displayPopup,
  editPaneCapture,
  getWindowName,
  getWindowOption,
  getWindowSize,
  hasSession,
  killPane,
  killSession,
  listPanes,
  newSession,
  newWindow,
  paneExists,
  paneIndexOrder,
  panePid,
  removeEnv,
  renameWindow,
  resizeWindow,
  resyncPaneSizes,
  selectLayout,
  selectPane,
  sendCtrlC,
  sendKeys,
  setEnv,
  setWindowOption,
  showEnv,
  splitPane,
  swapPanes,
  tmuxSupportsPopup,
  tmuxVersion,
  windowLayout,
  zoomPane,
} = defaultTmux;
