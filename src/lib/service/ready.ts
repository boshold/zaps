import { isReady } from "#src/lib/docker.js";
import type { ReadyConfig, ReadyDeps } from "./types.js";

import { isReadyDocker, isReadyOutput, isReadyPort } from "./types.js";

const POLL_INTERVAL = 500;
const TIMEOUT = 60_000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(checkFn: () => Promise<boolean>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new Error("Ready check aborted");
  }

  const start = Date.now();

  while (!signal.aborted) {
    // eslint-disable-next-line no-await-in-loop -- Sequential polling
    if (await checkFn()) {
      return;
    }
    if (Date.now() - start > TIMEOUT) {
      throw new Error("Ready check timed out after 60s");
    }
    // eslint-disable-next-line no-await-in-loop -- Sequential polling
    await sleep(POLL_INTERVAL);
  }
  throw new Error("Ready check aborted");
}

/**
 * Wait for a service to become ready based on its ReadyConfig.
 * Resolves immediately if config is undefined.
 * Returns discovered ports (non-empty only for docker mode).
 */
export async function waitForReady(
  config: ReadyConfig | undefined,
  paneTarget: string,
  signal: AbortSignal,
  deps: ReadyDeps,
): Promise<number[]> {
  if (!config) {
    return [];
  }

  if (isReadyDocker(config)) {
    if (!deps.dockerStatus) {
      throw new Error("Docker status dependency not provided");
    }
    const { dockerStatus } = deps;
    const file = config.file ?? deps.composeFile;
    let ports: number[] = [];
    await poll(async () => {
      const info = await dockerStatus(config.docker, deps.cwd, file);
      if (info && isReady(info)) {
        ({ ports } = info);
        return true;
      }
      return false;
    }, signal);
    return ports;
  }

  if (isReadyPort(config)) {
    if (config.port === true) {
      await poll(async () => {
        const ports = await deps.detectPorts(paneTarget);
        return ports.length > 0;
      }, signal);
    } else {
      const expectedPort = typeof config.port === "function" ? config.port() : config.port;
      await poll(async () => {
        const ports = await deps.detectPorts(paneTarget);
        return ports.includes(expectedPort);
      }, signal);
    }
    return [];
  }

  if (isReadyOutput(config)) {
    await poll(async () => {
      const output = await deps.capturePane(paneTarget, 200);
      const lines = output.split("\n");
      if (config.output instanceof RegExp) {
        return lines.some((line) => config.output instanceof RegExp && config.output.test(line));
      }
      return lines.some(config.output as (line: string) => boolean);
    }, signal);
    return [];
  }

  // Function mode
  if (typeof config === "function") {
    await poll(config, signal);
  }

  return [];
}
