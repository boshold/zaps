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
  hasSession,
  killSession,
  listSessions,
  newSession,
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
      const { render } = await import("ink");
      const { App } = await import("./components/App.js");
      const { waitUntilExit } = render(<App manager={manager} config={config} paneMap={paneMap} />);

      await waitUntilExit();

      // Cleanup — stopAll is idempotent, and it fires onStop hook internally
      await manager.stopAll();

      const sessionName = `zaps-${config.project.name}`;
      await killSession(sessionName).catch(() => {
        // Session may already be gone
      });
    } else {
      // Outer process: create session, layout, pass state, attach
      const configPath = discoverConfig(process.cwd());
      if (!configPath) {
        process.stderr.write("No config found. Run `zaps init` to create one.\n");
        process.exit(1);
      }

      const config = await loadConfig(configPath);

      // Check tmux available
      try {
        await listSessions();
      } catch {
        process.stderr.write("tmux is not installed or not available.\n");
        process.exit(1);
      }

      // Check for existing session
      const sessionName = `zaps-${config.project.name}`;
      if (await hasSession(sessionName)) {
        process.stderr.write(
          `Session '${sessionName}' already exists. Kill it first or use a different project name.\n`,
        );
        process.exit(1);
      }

      // Create tmux session
      await newSession(sessionName);

      // Build pane layout
      const paneMap = await createLayout(
        sessionName,
        config.project.layout,
        config.project.services,
      );

      // Serialize pane map to tmux env
      await setEnv(sessionName, "ZAPS_PANE_MAP", JSON.stringify(paneMap));

      // Resolve binary path
      const binCmd = process.argv.slice(0, 2).join(" ");
      const tuiPaneId = paneMap["@tui"];

      // Launch inner process in @tui pane
      await sendKeys(tuiPaneId, `${binCmd} ui --internal`);

      // Attach to tmux session (blocks until detach/exit)
      const { spawnSync } = await import("node:child_process");
      spawnSync("tmux", ["attach-session", "-t", sessionName], { stdio: "inherit" });
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
  .description("Stop all services and kill session")
  .option("-n, --name <name>", "Project name (auto-detected from config)")
  .action(async (opts: { name?: string }) => {
    let sessionName = "";
    if (opts.name) {
      sessionName = `zaps-${opts.name}`;
    } else {
      const configPath = discoverConfig(process.cwd());
      if (!configPath) {
        process.stderr.write("No config found. Use --name to specify project.\n");
        process.exit(1);
      }
      const config = await loadConfig(configPath);
      sessionName = `zaps-${config.project.name}`;
    }

    if (await hasSession(sessionName)) {
      await killSession(sessionName);
      process.stdout.write(`Killed session '${sessionName}'.\n`);
    } else {
      process.stdout.write(`No session '${sessionName}' found.\n`);
    }
  });

program.parse();
