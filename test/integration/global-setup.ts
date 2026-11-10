import { createTmuxIsolation } from "./helpers/tmux-isolation.js";

export default function setup() {
  const isolation = createTmuxIsolation();
  const previous = {
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR,
  };

  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  process.env.TMUX_TMPDIR = isolation.directory;

  return () => {
    isolation.cleanup();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  };
}
