import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { requireShellPty } from "../shell/pty-helper.js";

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

export function hasScriptPty(): boolean {
  try {
    requireShellPty();
    return true;
  } catch {
    return false;
  }
}

export const isCI = "CI" in process.env;
