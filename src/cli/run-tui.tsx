import { DaemonClient } from "#src/client/daemon-client.js";
import { getEnv } from "#src/lib/env.js";
import { installResizeReset } from "#src/lib/screen-reset.js";
import { currentSession } from "#src/lib/tmux.js";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStdoutSize(): string {
  return `${String(process.stdout.columns)}x${String(process.stdout.rows)}`;
}

/**
 * Wait until the terminal size stops changing before the first Ink paint.
 *
 * Inside tmux, `zaps up` splits its service/log panes around launch, so the
 * `@tui` pane keeps resizing for a few hundred ms. Ink only clears the screen on
 * a width *decrease* (see ink `resized`/`shouldClearTerminalForFrame`), so a
 * first frame painted mid-resize — typically while the pane is still *growing*
 * into its final width — is left on screen as residue until a manual tmux resize
 * triggers a clear. Settling the size first lets us paint exactly once at the
 * final dimensions. Resolves fast (~150ms) when the size is already stable.
 */
async function waitForStableSize(maxMs = 1000, stableMs = 150, stepMs = 50): Promise<void> {
  if (!process.stdout.isTTY) {
    return;
  }
  let prev = readStdoutSize();
  let stableFor = 0;
  for (let waited = 0; waited < maxMs; waited += stepMs) {
    await sleep(stepMs);
    const cur = readStdoutSize();
    if (cur === prev) {
      stableFor += stepMs;
      if (stableFor >= stableMs) {
        return;
      }
    } else {
      stableFor = 0;
      prev = cur;
    }
  }
}

export async function runTui(opts: {
  sessionId: string;
  socketPath: string;
  autoStart?: boolean;
}): Promise<void> {
  const client = new DaemonClient(opts.socketPath, opts.sessionId);

  let stopResizeReset: (() => void) | undefined = undefined;
  let alternateScreen = false;
  try {
    // Parallel: load yoga + attach to daemon (no config loading needed)
    const [yogaMod, snapshot] = await Promise.all([import("yoga-layout"), client.connectUi()]);
    const yogaReady: unknown = Reflect.get(yogaMod.default, "__yogaReady");
    await yogaReady;

    // Skip splash on reattach (services already running)
    const allStopped = snapshot.statuses.every((s) => s.state === "stopped");
    const showSplash = snapshot.backend === "tmux" && Boolean(opts.autoStart) && allStopped;

    process.stdout.write("\x1b[?1049h");
    alternateScreen = true;

    if (showSplash) {
      const { managedSplashHint, renderSplash } = await import("#src/components/logo.js");
      const { resolveIconTier } = await import("#src/components/theme/IconTheme.js");
      const { listPanes } = await import("#src/lib/tmux.js");
      const splashTier = resolveIconTier(snapshot.ui?.icons);
      const hint = managedSplashHint(getEnv("ZAPS_MANAGED_TMUX"));
      const tmuxSession = await currentSession();
      const panes = await listPanes(tmuxSession);
      const tuiPane = panes.find((p) => p.id === snapshot.paneMap["@tui"]);
      if (tuiPane) {
        renderSplash({ cols: tuiPane.width, rows: tuiPane.height }, splashTier, hint);
      } else {
        renderSplash(undefined, splashTier, hint);
      }
    }

    // Parallel: load ink + App component
    const [{ render }, { App }] = await Promise.all([
      import("ink"),
      import("#src/components/App.js"),
    ]);

    // Let the pane size settle (after zaps' own pane splits), then clear so the
    // First frame paints once, clean, at the final size — no splash or mid-resize
    // Residue left behind for a manual tmux resize to mop up.
    await waitForStableSize();
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    }

    // Zaps keeps splitting/resizing the @tui pane after mount. Ink only force-
    // Clears on a width *decrease*, so growing into the final size leaves frame
    // Residue. Mop up the cases Ink misses; the live reflow then repaints clean.
    stopResizeReset = installResizeReset(process.stdout);

    const { waitUntilExit } = render(
      <App
        client={client}
        paneMap={snapshot.paneMap}
        projectName={snapshot.name}
        tasks={snapshot.tasks}
        servicesMeta={snapshot.servicesMeta}
        backend={snapshot.backend}
        capabilities={snapshot.capabilities}
        initialStatuses={snapshot.statuses}
        initialTaskHistory={snapshot.taskHistory}
        autoStart={showSplash}
        configStale={snapshot.configStale}
        ui={snapshot.ui}
      />,
      {
        patchConsole: false,
        exitOnCtrlC: false,
        // On a real pty, paint frames even when CI env vars leak into the pane
        // (a tmux server started on CI hands CI=true to every pane, and Ink's
        // Is-in-ci check would then skip every frame until unmount).
        interactive: process.stdout.isTTY ? true : undefined,
      },
    );

    await waitUntilExit();
  } finally {
    stopResizeReset?.();
    if (alternateScreen) {
      process.stdout.write("\x1b[?1049l");
    }
    client.disconnect();
  }
}
