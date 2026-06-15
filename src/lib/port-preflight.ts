import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

import type { ServiceConfig } from "#src/config/types.js";
import { isReadyPort } from "#src/config/types.js";

const execFileAsync = promisify(execFile);
const CONNECT_TIMEOUT_MS = 500;

/** Run a command and return stdout, or "" on any failure. */
async function execOut(cmd: string, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, cwd ? { cwd } : {});
    return stdout;
  } catch {
    return "";
  }
}

async function defaultComposeConfig(cwd: string, file: string | undefined): Promise<string> {
  const args = ["compose"];
  if (file) {
    args.push("-f", file);
  }
  args.push("config", "--format", "json");
  return execOut("docker", args, cwd);
}

/** Parse JSON, signalling failure without throwing. */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Read a property off an unknown value without unsafe casts. */
function prop(obj: unknown, key: string): unknown {
  return typeof obj === "object" && obj !== null ? Reflect.get(obj, key) : undefined;
}

/** Parse the port from a local address string (e.g. "0.0.0.0:5432", "*:3000"). */
function parsePort(addr: string): number {
  const lastColon = addr.lastIndexOf(":");
  if (lastColon === -1) {
    return Number.NaN;
  }
  return Number.parseInt(addr.substring(lastColon + 1), 10);
}

/** How port pre-flight reaches docker compose — injectable for testing. */
export interface PreflightDeps {
  composeConfig?: (cwd: string, file: string | undefined) => Promise<string>;
}

/**
 * Expand a compose `published` host-port string into individual ports.
 * Handles a single port (`"8080"`) and a range (`"8080-8081"`). Returns [] for
 * empty/unparseable values.
 */
export function expandPortRange(published: string): number[] {
  const trimmed = published.trim();
  if (trimmed === "") {
    return [];
  }
  const [startStr, endStr] = trimmed.split("-");
  const start = Number.parseInt(startStr, 10);
  if (Number.isNaN(start)) {
    return [];
  }
  if (endStr === undefined) {
    return [start];
  }
  const end = Number.parseInt(endStr, 10);
  if (Number.isNaN(end) || end < start) {
    return [start];
  }
  const ports: number[] = [];
  for (let p = start; p <= end; p += 1) {
    ports.push(p);
  }
  return ports;
}

/**
 * Parse published host ports for the given service names from
 * `docker compose config --format json` output. Returns null when the output
 * is not JSON (compose v2.25/v2.26 emits YAML — caller skips pre-flight).
 * Entries without a `published` field (unpublished ports) are skipped.
 */
export function parseComposePorts(configJson: string, serviceNames: string[]): number[] | null {
  const parsed = tryParseJson(configJson);
  if (!parsed.ok) {
    return null;
  }
  const services = prop(parsed.value, "services");
  const result = new Set<number>();
  for (const name of serviceNames) {
    const ports = prop(prop(services, name), "ports");
    if (!Array.isArray(ports)) {
      // eslint-disable-next-line no-continue -- service may have no ports
      continue;
    }
    for (const entry of ports) {
      const published = prop(entry, "published");
      if (typeof published === "string") {
        for (const p of expandPortRange(published)) {
          result.add(p);
        }
      } else if (typeof published === "number") {
        result.add(published);
      }
    }
  }
  return [...result];
}

/**
 * Derive the host ports a service is expected to bind. `skipped` is true when a
 * docker service's compose config couldn't be read as JSON (pre-flight is then
 * bypassed, never blocking start).
 */
export async function deriveExpectedPorts(
  serviceConfig: ServiceConfig,
  projectDir: string,
  deps: PreflightDeps = {},
): Promise<{ ports: number[]; skipped: boolean }> {
  const { ready } = serviceConfig;
  if (ready && isReadyPort(ready) && typeof ready.port === "number") {
    return { ports: [ready.port], skipped: false };
  }

  if (serviceConfig.docker) {
    const { file, service } = serviceConfig.docker;
    const cwd = serviceConfig.cwd ?? projectDir;
    const run = deps.composeConfig ?? defaultComposeConfig;
    const out = await run(cwd, file);
    const serviceNames = Array.isArray(service) ? service : [service];
    const ports = parseComposePorts(out, serviceNames);
    if (ports === null) {
      process.stderr.write(
        `Warning: could not parse 'docker compose config' output as JSON; skipping port pre-flight.\n`,
      );
      return { ports: [], skipped: true };
    }
    return { ports, skipped: false };
  }

  return { ports: [], skipped: false };
}

/**
 * Test whether a TCP port is already accepting connections on 127.0.0.1.
 * Connect-based (not bind-based): catches SO_REUSEPORT/root-owned listeners that
 * a bind test would miss. A connect success means the port is taken.
 */
export async function isPortInUse(port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (inUse: boolean): void => {
      socket.destroy();
      resolve(inUse);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

/** Parse `ss -tlnp` output for the owner of a listening port. */
export function parseSsOwner(output: string, port: number): string | undefined {
  for (const line of output.split("\n")) {
    if (!line.includes("LISTEN")) {
      // eslint-disable-next-line no-continue -- only LISTEN rows
      continue;
    }
    const localAddr = line.trim().split(/\s+/u).at(3);
    if (!localAddr || parsePort(localAddr) !== port) {
      // eslint-disable-next-line no-continue -- different port
      continue;
    }
    const match = /\(\("(?<name>[^"]+)",pid=(?<pid>\d+)/u.exec(line);
    if (match?.groups) {
      return `pid ${match.groups.pid} ${match.groups.name}`;
    }
    return undefined;
  }
  return undefined;
}

/** Parse `lsof -iTCP:<port> -sTCP:LISTEN -nP` output for the owner. */
export function parseLsofOwner(output: string, port: number): string | undefined {
  const lines = output.trim().split("\n");
  // Skip the header row.
  for (let i = 1; i < lines.length; i += 1) {
    const fields = lines[i].trim().split(/\s+/u);
    if (fields.length < 9) {
      // eslint-disable-next-line no-continue -- malformed row
      continue;
    }
    // The NAME column (e.g. `*:5432`) precedes a trailing `(LISTEN)` token.
    let addr = "";
    for (let j = fields.length - 1; j >= 0; j -= 1) {
      if (fields[j].includes(":") && !fields[j].startsWith("(")) {
        addr = fields[j];
        break;
      }
    }
    if (parsePort(addr) === port) {
      return `pid ${fields[1]} ${fields[0]}`;
    }
  }
  return undefined;
}

/** Best-effort owner attribution for a listening port (decoration only). */
export async function attributePort(port: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    const ssOwner = parseSsOwner(await execOut("ss", ["-tlnp"]), port);
    if (ssOwner) {
      return ssOwner;
    }
  }
  return parseLsofOwner(await execOut("lsof", [`-iTCP:${port}`, "-sTCP:LISTEN", "-nP"]), port);
}

/**
 * Pre-flight a service's expected host ports. Returns an actionable conflict
 * message (`Port 5432 already in use (pid 1234 postgres)`) for the first port
 * already in use, or null when all expected ports are free / none are derivable.
 */
export async function checkPortPreflight(
  serviceConfig: ServiceConfig,
  projectDir: string,
  deps: PreflightDeps = {},
): Promise<string | null> {
  const { ports } = await deriveExpectedPorts(serviceConfig, projectDir, deps);
  for (const port of ports) {
    // eslint-disable-next-line no-await-in-loop -- check sequentially, report first conflict
    if (await isPortInUse(port)) {
      // eslint-disable-next-line no-await-in-loop -- attribution only on conflict
      const owner = await attributePort(port);
      return owner ? `Port ${port} already in use (${owner})` : `Port ${port} already in use`;
    }
  }
  return null;
}
