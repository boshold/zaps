#!/usr/bin/env node
import path from "node:path";

import { program } from "commander";
import { render } from "ink";

import { App } from "./components/App.js";
import { discoverConfig } from "./config/discovery.js";
import { scaffoldConfig } from "./config/scaffold.js";
import { listSessions } from "./lib/tmux.js";

program.name("zaps").version("0.1.0").description("Terminal session manager");

program
  .command("ui")
  .description("Launch interactive TUI")
  .action(() => {
    render(<App />);
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

program.parse();
