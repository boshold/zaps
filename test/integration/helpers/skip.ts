import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function hasDocker(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function hasBinary(): boolean {
  return fs.existsSync(path.resolve("dist/zaps"));
}

/**
 * True if `script` can allocate a pty for the exact form the popup tests use to
 * attach a tmux client (`script -qec <cmd> /dev/null`). tmux `display-popup`
 * needs an attached client ("no current client" otherwise), which the headless
 * harness only gets via a real pty. BSD `script` uses a different signature, so
 * probe the concrete invocation rather than mere presence.
 */
export function hasScriptPty(): boolean {
  try {
    execFileSync("script", ["-qec", "true", "/dev/null"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const isCI = "CI" in process.env;
