import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DockerConfig } from "#src/config/types.js";

const execFileAsync = promisify(execFile);

interface DockerContainerInfo {
  state: string;
  health: string;
  ports: number[];
}

/**
 * Execute a command and return stdout. Returns empty string on error.
 */
async function exec(cmd: string, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, cwd ? { cwd } : {});
    return stdout;
  } catch {
    return "";
  }
}

function toStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Extract unique published host ports from Publishers array.
 */
function extractPorts(publishers: unknown): number[] {
  if (!Array.isArray(publishers)) {
    return [];
  }
  const ports = new Set<number>();
  for (const pub of publishers) {
    if (pub && typeof pub === "object" && "PublishedPort" in pub) {
      const p: unknown = pub.PublishedPort;
      if (typeof p === "number" && p > 0) {
        ports.add(p);
      }
    }
  }
  return [...ports].toSorted((a, b) => a - b);
}

function parseRecord(record: Record<string, unknown>): DockerContainerInfo {
  return {
    state: toStr(record.State),
    health: toStr(record.Health),
    ports: extractPorts(record.Publishers),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse docker compose ps JSON output into container info.
 * Handles JSONL (one JSON object per line) and JSON array formats.
 */
function parseContainerInfo(output: string): DockerContainerInfo | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const [first]: unknown[] = parsed;
      if (!isRecord(first)) {
        return null;
      }
      return parseRecord(first);
    }
    if (isRecord(parsed)) {
      return parseRecord(parsed);
    }
    return null;
  } catch {
    // Try JSONL: take first non-empty line
    for (const line of trimmed.split("\n")) {
      const l = line.trim();
      if (l) {
        try {
          const obj: unknown = JSON.parse(l);
          if (isRecord(obj)) {
            return parseRecord(obj);
          }
        } catch {
          // Skip malformed line
        }
      }
    }
    return null;
  }
}

/**
 * Check if a container is ready: state=running AND (no healthcheck OR healthy).
 */
function isReady(info: DockerContainerInfo): boolean {
  return info.state === "running" && (info.health === "" || info.health === "healthy");
}

/**
 * Get container info for a docker compose service.
 */
async function getContainerInfo(
  service: string,
  cwd?: string,
  composeFile?: string,
): Promise<DockerContainerInfo | null> {
  const args = ["compose"];
  if (composeFile) {
    args.push("-f", composeFile);
  }
  args.push("ps", "--format", "json", service);
  const output = await exec("docker", args, cwd);
  return parseContainerInfo(output);
}

/**
 * Build a `docker compose up` command from a DockerConfig.
 */
function buildDockerCommand(config: DockerConfig): string {
  const args = ["docker", "compose"];
  if (config.file) {
    args.push("-f", config.file);
  }
  args.push("up");
  if (config.build) {
    args.push("--build");
  }
  if (config.forceRecreate) {
    args.push("--force-recreate");
  }
  if (config.renewVolumes) {
    args.push("-V");
  }
  if (config.removeOrphans) {
    args.push("--remove-orphans");
  }
  if (config.pull) {
    args.push("--pull", config.pull);
  }
  if (config.noDeps) {
    args.push("--no-deps");
  }
  const services = Array.isArray(config.service) ? config.service : [config.service];
  args.push(...services);
  return args.join(" ");
}

export type { DockerContainerInfo };
export { parseContainerInfo, isReady, getContainerInfo, buildDockerCommand };
