#!/usr/bin/env node
import { program } from "commander";
import { render } from "ink";
import { App } from "./components/App.js";
import { listSessions } from "./lib/tmux.js";

program.name("zaps").version("0.1.0").description("Terminal session manager");

program.command("ui").description("Launch interactive TUI").action(() => {
  render(<App />);
});

program
  .command("sessions")
  .description("List tmux sessions")
  .action(async () => {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log("No tmux sessions found.");
      return;
    }
    for (const s of sessions) {
      console.log(s);
    }
  });

program.parse();
