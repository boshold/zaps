import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

import { z } from "zod";

interface RequestContext {
  cwd: string;
  env: Record<string, string>;
}

const requestContextSchema = z.object({
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
});

const environmentSchema = z.record(z.string(), z.string());
const ENVIRONMENT_SNAPSHOT_VARIABLE = "ZAPS_ENVIRONMENT_SNAPSHOT";

const environmentStorage = new AsyncLocalStorage<Record<string, string>>();
const baseEnvironment = process.env;
let contextualEnvironmentInstalled = false;

function installContextualEnvironment(): void {
  if (contextualEnvironmentInstalled) {
    return;
  }
  contextualEnvironmentInstalled = true;
  Object.defineProperty(process, "env", {
    configurable: true,
    enumerable: true,
    get: () => environmentStorage.getStore() ?? baseEnvironment,
    set: (value: NodeJS.ProcessEnv) => {
      const target = environmentStorage.getStore() ?? baseEnvironment;
      for (const key of Object.keys(target)) {
        Reflect.deleteProperty(target, key);
      }
      for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
          target[key] = entry;
        }
      }
    },
  });
}

export function captureEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      captured[key] = value;
    }
  }
  return captured;
}

export function captureRequestContext(): RequestContext {
  return { cwd: process.cwd(), env: captureEnvironment() };
}

export function parseRequestContext(value: unknown): RequestContext {
  const parsed = requestContextSchema.parse(value);
  if (!path.isAbsolute(parsed.cwd)) {
    throw new Error("request context cwd must be absolute");
  }
  return parsed;
}

export function runWithEnvironment<T>(env: Record<string, string>, action: () => T): T {
  installContextualEnvironment();
  return environmentStorage.run(env, action);
}

export function writeEnvironmentSnapshot(directory: string, env: Record<string, string>): string {
  const filePath = path.join(directory, `environment-${randomUUID()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(env), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return filePath;
}

export function removeEnvironmentSnapshot(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* Already consumed or unavailable. */
  }
}

export function consumeEnvironmentSnapshot(): void {
  const filePath = process.env[ENVIRONMENT_SNAPSHOT_VARIABLE];
  if (!filePath) {
    return;
  }

  const tmuxSocket = process.env.ZAPS_TMUX_SOCKET;
  const tmuxPane = process.env.TMUX_PANE;
  if (process.env.ZAPS_MANAGED_TMUX === "1" && tmuxSocket && tmuxPane) {
    try {
      execFileSync(
        "tmux",
        ["-L", tmuxSocket, "set-environment", "-u", "-t", tmuxPane, ENVIRONMENT_SNAPSHOT_VARIABLE],
        { stdio: "ignore" },
      );
    } catch {
      /* The process-local cleanup below is sufficient for this invocation. */
    }
  }

  const tmuxEnvironment = captureEnvironment({
    TMUX: process.env.TMUX,
    TMUX_PANE: process.env.TMUX_PANE,
    TERM: process.env.TERM,
    ZAPS_TMUX_SOCKET: process.env.ZAPS_TMUX_SOCKET,
    ZAPS_MANAGED_TMUX: process.env.ZAPS_MANAGED_TMUX,
  });
  try {
    const content = (() => {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          Reflect.deleteProperty(process.env, ENVIRONMENT_SNAPSHOT_VARIABLE);
          return undefined;
        }
        throw error;
      }
    })();
    if (content === undefined) {
      return;
    }
    const env = environmentSchema.parse(JSON.parse(content));
    Reflect.deleteProperty(env, ENVIRONMENT_SNAPSHOT_VARIABLE);
    for (const key of Object.keys(process.env)) {
      Reflect.deleteProperty(process.env, key);
    }
    Object.assign(process.env, env, tmuxEnvironment);
  } finally {
    removeEnvironmentSnapshot(filePath);
  }
}

export function loadProjectEnv(projectDir: string): Record<string, string> {
  const envPath = path.join(projectDir, ".env");
  try {
    return captureEnvironment(parseEnv(fs.readFileSync(envPath, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new Error(
      `Failed to load ${envPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function resolveEnvironment(
  projectDir: string,
  shellEnv: Record<string, string>,
): Record<string, string> {
  return { ...loadProjectEnv(projectDir), ...shellEnv };
}

export { ENVIRONMENT_SNAPSHOT_VARIABLE };
export type { RequestContext };
