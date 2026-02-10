import type { ReadyConfig, ReadyDeps } from "./types.js";

import { isReadyOutput, isReadyPort } from "./types.js";

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
    if (await checkFn()) {
      return;
    }
    if (Date.now() - start > TIMEOUT) {
      throw new Error("Ready check timed out after 60s");
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error("Ready check aborted");
}

/**
 * Wait for a service to become ready based on its ReadyConfig.
 * Resolves immediately if config is undefined.
 */
export async function waitForReady(
  config: ReadyConfig | undefined,
  paneTarget: string,
  signal: AbortSignal,
  deps: ReadyDeps,
): Promise<void> {
  if (!config) {
    return;
  }

  if (isReadyPort(config)) {
    const expectedPort = typeof config.port === "function" ? config.port() : config.port;
    await poll(async () => {
      const ports = await deps.detectPorts(paneTarget);
      return ports.includes(expectedPort);
    }, signal);
    return;
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
    return;
  }

  // Function mode
  if (typeof config === "function") {
    await poll(config, signal);
  }
}
