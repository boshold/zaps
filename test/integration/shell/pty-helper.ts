import { spawnSync } from "node:child_process";

export function scriptPtyArgs(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "linux") {
    return ["-qec", command, "/dev/null"];
  }
  // Apple script(1): transcript first, then command argv; child status is propagated.
  if (platform === "darwin") {
    return ["-q", "/dev/null", "/bin/sh", "-c", command];
  }
  throw new Error(`Required shell PTY unsupported on ${platform}`);
}

export function requireShellPty(): void {
  const command = String.raw`test -t 0 && test -t 1 || exit 8; IFS= read -r key; test "$key" = q || exit 9; printf "SHELL_PTY_KEY_OK\n"; exit 7`;
  const probe = spawnSync("script", scriptPtyArgs(command), {
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
