export function ptyEnvironment(): NodeJS.ProcessEnv {
  // Headless test shells may use TERM=dumb; tmux clients need a usable terminal.
  return { ...process.env, TERM: "xterm-256color" };
}
