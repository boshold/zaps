import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { DockerConfig } from "#src/config/types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

interface DockerContainerInfo {
  state: string;
  health: string;
  ports: number[];
  /** Container ID(s) — used to detect recreate (B4). Deduped and sorted. */
  ids: string[];
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

/** Compose project-name sanitization: lowercase, non-`[a-z0-9_-]` → `-`. */
function sanitizeProjectName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/gu, "-");
}

/** First 6 hex chars of a stable hash — keeps same-basename dirs distinct. */
function hash6(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 6);
}

function readFileOrUndefined(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** Read the top-level `name:` from the service's compose file(s), if any. */
function readComposeFileName(cwd: string, file: string | undefined): string | undefined {
  const candidates = file
    ? [path.resolve(cwd, file)]
    : DEFAULT_COMPOSE_FILES.map((f) => path.join(cwd, f));
  for (const candidate of candidates) {
    const content = readFileOrUndefined(candidate);
    if (content === undefined) {
      // eslint-disable-next-line no-continue -- file may not exist
      continue;
    }
    const match = /^name:[ \t]*(?<name>\S+)/mu.exec(content);
    if (match?.groups?.name) {
      return match.groups.name.replace(/^["']|["']$/gu, "");
    }
  }
  return undefined;
}

/**
 * Resolve the compose project name (B5). Precedence: `docker.projectName` >
 * `ZAPS_COMPOSE_PROJECT` env > compose-file top-level `name:` > a deterministic
 * `zaps-<sanitize(basename)>-<hash6(abs cwd)>` pin (distinct for same-basename
 * directories in different paths).
 */
function resolveProjectName(
  cwd: string,
  dockerConfig: Pick<DockerConfig, "projectName" | "file">,
): string {
  if (dockerConfig.projectName) {
    return dockerConfig.projectName;
  }
  const env = process.env.ZAPS_COMPOSE_PROJECT;
  if (env) {
    return env;
  }
  const fileName = readComposeFileName(cwd, dockerConfig.file);
  if (fileName) {
    return fileName;
  }
  const abs = path.resolve(cwd);
  return `zaps-${sanitizeProjectName(path.basename(abs))}-${hash6(abs)}`;
}

/**
 * The `-p <project>` args to pin EVERY compose invocation to a deterministic
 * project, so a foreign container in a same-named directory can't be mistaken
 * for this service's (B5).
 */
function composeProjectArgs(
  cwd: string,
  dockerConfig: Pick<DockerConfig, "projectName" | "file">,
): string[] {
  return ["-p", resolveProjectName(cwd, dockerConfig)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  return [...ports];
}

function parseRecord(record: Record<string, unknown>): DockerContainerInfo {
  const id = toStr(record.ID) || toStr(record.Name);
  return {
    state: toStr(record.State),
    health: toStr(record.Health),
    ports: extractPorts(record.Publishers),
    ids: id ? [id] : [],
  };
}

/**
 * Collect every record from `compose ps --format json` across all three output
 * shapes: a JSON array (≤ v2.20), JSONL one-object-per-line (≥ v2.21), or a
 * single bare object. A malformed JSONL line is skipped, not fatal.
 */
function parseAllRecords(output: string): Record<string, unknown>[] {
  const trimmed = output.trim();
  if (trimmed === "") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter(isRecord);
    }
    return isRecord(parsed) ? [parsed] : [];
  } catch {
    const records: Record<string, unknown>[] = [];
    for (const line of trimmed.split("\n")) {
      const trimmedLine = line.trim();
      if (trimmedLine === "") {
        // eslint-disable-next-line no-continue -- blank line
        continue;
      }
      try {
        const obj: unknown = JSON.parse(trimmedLine);
        if (isRecord(obj)) {
          records.push(obj);
        }
      } catch {
        // Skip a malformed line but keep the valid ones.
      }
    }
    return records;
  }
}

/**
 * Check if a container is ready: state=running AND (no healthcheck OR healthy).
 */
function isReady(info: DockerContainerInfo): boolean {
  return info.state === "running" && (info.health === "" || info.health === "healthy");
}

/**
 * Parse docker compose ps JSON output into aggregate container info across all
 * records (scaled services). Ready iff every record is ready; ports are merged;
 * if any record isn't ready, its state/health propagate (e.g. `exited`) so the
 * ready loop can fail fast (B6).
 */
function parseContainerInfo(output: string): DockerContainerInfo | null {
  const infos = parseAllRecords(output).map(parseRecord);
  if (infos.length === 0) {
    return null;
  }
  const ports = [...new Set(infos.flatMap((i) => i.ports))].toSorted((a, b) => a - b);
  const ids = [...new Set(infos.flatMap((i) => i.ids))].toSorted();
  // First non-ready record carries the failure reason; otherwise the first.
  const base = infos.find((i) => !isReady(i)) ?? infos[0];
  return { state: base.state, health: base.health, ports, ids };
}

/**
 * Get container info for a docker compose service. Uses `-a` so exited/crashed
 * containers are returned instead of hidden (compose hides them by default
 * since v2.14.2 — B2).
 */
async function getContainerInfo(
  service: string,
  cwd?: string,
  composeFile?: string,
  projectArgs: string[] = [],
): Promise<DockerContainerInfo | null> {
  const args = ["compose", ...projectArgs];
  if (composeFile) {
    args.push("-f", composeFile);
  }
  args.push("ps", "-a", "--format", "json", service);
  const output = await exec("docker", args, cwd);
  return parseContainerInfo(output);
}

/**
 * Best-effort one-time migration warning: if containers exist under the legacy
 * unpinned project name (cwd basename) that differs from the resolved pin,
 * return a message suggesting cleanup. Any failure resolves to undefined.
 */
async function legacyProjectWarning(
  cwd: string,
  dockerConfig: Pick<DockerConfig, "projectName" | "file">,
): Promise<string | undefined> {
  const pinned = resolveProjectName(cwd, dockerConfig);
  const legacy = sanitizeProjectName(path.basename(path.resolve(cwd)));
  if (legacy === "" || legacy === pinned) {
    return undefined;
  }
  const output = await exec(
    "docker",
    ["compose", "-p", legacy, "ps", "-a", "--format", "json"],
    cwd,
  );
  if (parseAllRecords(output).length === 0) {
    return undefined;
  }
  return (
    `Containers exist under the legacy compose project '${legacy}'; zaps now pins this ` +
    `project to '${pinned}'. Run 'docker compose -p ${legacy} down' to remove the old set.`
  );
}

/**
 * Build a `docker compose up` command from a DockerConfig, pinned to the
 * resolved project (B5).
 */
function buildDockerCommand(config: DockerConfig, cwd: string): string {
  const args = ["docker", "compose", ...composeProjectArgs(cwd, config)];
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
export {
  parseContainerInfo,
  isReady,
  getContainerInfo,
  buildDockerCommand,
  composeProjectArgs,
  legacyProjectWarning,
  sanitizeProjectName,
};
