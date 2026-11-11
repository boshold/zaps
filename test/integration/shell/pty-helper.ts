import { spawnSync } from "node:child_process";

interface PtyLauncher {
  readonly file: string;
  readonly args: string[];
}

// Apple script(1) requires a TTY on stdin, so macOS uses Python's pty.spawn instead.
const DARWIN_PTY = [
  "import os, pty, sys",
  "code = os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:]))",
  "sys.exit(code if code >= 0 else 128 - code)",
].join("\n");

export function shellPty(
  command: string,
  platform: NodeJS.Platform = process.platform,
): PtyLauncher {
  if (platform === "linux") {
    return { file: "script", args: ["-qec", command, "/dev/null"] };
  }
  if (platform === "darwin") {
    return { file: "python3", args: ["-c", DARWIN_PTY, "/bin/sh", "-c", command] };
  }
  throw new Error(`Required shell PTY unsupported on ${platform}`);
}

export function requireShellPty(): void {
  const command = String.raw`test -t 0 && test -t 1 || exit 8; IFS= read -r key; test "$key" = q || exit 9; printf "SHELL_PTY_KEY_OK\n"; exit 7`;
  const pty = shellPty(command);
  const probe = spawnSync(pty.file, pty.args, {
    env: { ...process.env, SHELL: "/bin/sh", TERM: "xterm-256color" },
    input: "q\n",
    encoding: "utf8",
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  if (probe.error || probe.status !== 7 || !probe.stdout.includes("SHELL_PTY_KEY_OK")) {
    throw new Error(
      `Required shell PTY prerequisite failed on ${process.platform}: ${String(probe.error ?? probe.status)} ${probe.stdout} ${probe.stderr}`,
    );
  }
}
