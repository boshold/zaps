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

export const isCI = "CI" in process.env;
