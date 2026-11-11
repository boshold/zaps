export function ptyEnvironment(): NodeJS.ProcessEnv {
  // Headless test shells may use TERM=dumb; tmux clients need a usable terminal.
  return { ...process.env, TERM: "xterm-256color" };
}

export function scriptPtyArgs(command: string): string[] {
  return process.platform === "darwin"
    ? ["-q", "/dev/null", "/bin/sh", "-c", command]
    : ["-qec", command, "/dev/null"];
}
