#!/usr/bin/env node
import path from "node:path";

import type { ServiceManagerDeps } from "./lib/service/manager.js";
import { program } from "commander";

import { discoverConfig } from "./config/discovery.js";
import { loadConfig } from "./config/loader.js";
import { scaffoldConfig } from "./config/scaffold.js";
import { detectPorts, getDescendantPids } from "./lib/port.js";
import { createLayout } from "./lib/tmux-layout.js";
import {
  capturePane,
  currentPaneId,
  currentSession,
  killPane,
  listSessions,
  panePid,
  sendCtrlC,
  sendKeys,
  setEnv,
} from "./lib/tmux.js";

program.name("zaps").version("0.1.0").description("Terminal session manager");

/**
 * Build real ServiceManagerDeps from the actual tmux/port modules.
 */
function buildDeps(): ServiceManagerDeps {
  return {
    sendKeys,
    sendCtrlC,
    panePid,
    detectPorts,
    capturePane,
    getDescendantPids,
  };
}

program
  .command("ui", { isDefault: true })
  .description("Launch zaps TUI")
  .option("--internal", "Internal: run inside tmux pane")
  .action(async (opts: { internal?: boolean }) => {
    if (opts.internal) {
      // Inner process: session already exists, paneMap in env
      const configPath = discoverConfig(process.cwd());
      if (!configPath) {
        process.stderr.write("No config found.\n");
        process.exit(1);
      }

      const config = await loadConfig(configPath);

      // Read pane map from tmux environment
      // eslint-disable-next-line node/no-process-env -- Inner process reads serialized pane map from tmux env
      const paneMapRaw = process.env["ZAPS_PANE_MAP"];
      if (!paneMapRaw) {
        process.stderr.write("ZAPS_PANE_MAP not set. Must run via outer process.\n");
        process.exit(1);
      }

      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Serialized by outer process
      const paneMap = JSON.parse(paneMapRaw) as Record<string, string>;
      const deps = buildDeps();
      const { ServiceManager } = await import("./lib/service/manager.js");
      const manager = new ServiceManager(config, paneMap, deps);

      // Start services
      await manager.startAll();

      // Render TUI (dynamic import to avoid TLA from ink/yoga-layout at top level)
      // Ensure yoga-wasm is loaded before Ink creates layout nodes.
      // The build plugin (scripts/build.ts) exposes __yogaReady on the Proxy default export.
      // In dev (unbundled), yoga-layout's real TLA handles init, so this resolves undefined (no-op).
      const { default: yoga } = await import("yoga-layout");
      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- __yogaReady is injected at build time
      await (yoga as unknown as Record<string, unknown>)["__yogaReady"];

      const { render } = await import("ink");
      const { App } = await import("./components/App.js");
      const { waitUntilExit } = render(<App manager={manager} config={config} paneMap={paneMap} />);

      await waitUntilExit();

      // Cleanup — stopAll is idempotent, and it fires onStop hook internally
      await manager.stopAll();

      // Kill spawned panes, but preserve the origin pane
      // eslint-disable-next-line node/no-process-env -- Inner process reads origin pane from env
      const originPane = process.env["ZAPS_ORIGIN_PANE"];
      for (const paneId of Object.values(paneMap)) {
        if (paneId !== originPane) {
          // eslint-disable-next-line no-await-in-loop -- Sequential tmux operations
          await killPane(paneId).catch(() => { /* Pane may already be gone */ });
        }
      }
    } else {
      // Outer process: split panes in current tmux window, pass state, exit
      const configPath = discoverConfig(process.cwd());
      if (!configPath) {
        process.stderr.write("No config found. Run `zaps init` to create one.\n");
        process.exit(1);
      }

      const config = await loadConfig(configPath);

      // Must be inside tmux
      // eslint-disable-next-line node/no-process-env -- Check if running inside tmux
      if (!process.env["TMUX"]) {
        process.stderr.write("zaps must be run from inside a tmux session.\n");
        process.exit(1);
      }

      // Get current pane and session
      const originPane = await currentPaneId();
      const sessionName = await currentSession();

      // Build pane layout starting from current pane
      const paneMap = await createLayout(
        originPane,
        config.project.layout,
        config.project.services,
      );

      // Serialize pane map and origin pane to tmux env
      await setEnv(sessionName, "ZAPS_PANE_MAP", JSON.stringify(paneMap));

      // Resolve binary path
      const binCmd = process.argv.slice(0, 2).join(" ");
      const tuiPaneId = paneMap["@tui"];

      // Launch inner process in @tui pane with origin pane info
      await sendKeys(tuiPaneId, `ZAPS_ORIGIN_PANE=${originPane} ${binCmd} ui --internal`);
    }
  });

program
  .command("sessions")
  .description("List tmux sessions")
  .action(async () => {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      process.stdout.write("No tmux sessions found.\n");
      return;
    }
    for (const session of sessions) {
      process.stdout.write(`${session}\n`);
    }
  });

program
  .command("init")
  .description("Create a starter .zaps.mts config")
  .action(async () => {
    const cwd = process.cwd();
    const existing = discoverConfig(cwd);
    if (existing) {
      process.stderr.write(`Config already exists: ${existing}\n`);
      process.exit(1);
    }
    const written = await scaffoldConfig(cwd, path.basename(cwd));
    process.stdout.write(`Created ${written}\n`);
  });

program
  .command("down")
  .description("Stop all services and kill spawned panes")
  .action(async () => {
    // Must be inside tmux
    // eslint-disable-next-line node/no-process-env -- Check if running inside tmux
    if (!process.env["TMUX"]) {
      process.stderr.write("zaps must be run from inside a tmux session.\n");
      process.exit(1);
    }

    const sessionName = await currentSession();

    // Read pane map from tmux env
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("tmux", ["show-environment", "-t", sessionName, "ZAPS_PANE_MAP"], {
      encoding: "utf8",
    });

    if (result.status !== 0 || !result.stdout) {
      process.stderr.write("No active zaps panes found in this session.\n");
      process.exit(1);
    }

    // Output format: ZAPS_PANE_MAP={"@tui":"%0",...}
    const raw = result.stdout.trim().replace(/^ZAPS_PANE_MAP=/, "");
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Serialized by outer process
    const paneMap = JSON.parse(raw) as Record<string, string>;
    const originPane = await currentPaneId();

    let killed = 0;
    for (const paneId of Object.values(paneMap)) {
      if (paneId !== originPane) {
        // eslint-disable-next-line no-await-in-loop -- Sequential tmux operations
        await killPane(paneId).catch(() => { /* Pane may already be gone */ });
        killed += 1;
      }
    }

    process.stdout.write(`Killed ${killed} pane(s).\n`);
  });

program.parse();
