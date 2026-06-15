import { isReady } from "#src/lib/docker.js";
import { selectProbeCandidates } from "#src/lib/probe.js";

import type { ReadyConfig, ReadyDeps } from "./types.js";
import { isReadyDocker, isReadyHttp, isReadyOutput, isReadyPort } from "./types.js";

const POLL_INTERVAL = 500;
const TIMEOUT = 60_000;
const TAIL_LINES = 20;
// A container that stays terminal (exited/dead) this long fails fast instead of
// Waiting out the full timeout — long enough to ignore the transient `exited`
// Seen while a crashed container is being recreated/restarted (B2).
const TERMINAL_GRACE = 10_000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(
  checkFn: () => Promise<boolean>,
  signal: AbortSignal,
  buildTimeoutError?: () => Promise<Error>,
): Promise<void> {
  if (signal.aborted) {
    return;
  }

  const start = Date.now();

  while (!signal.aborted) {
    if (await checkFn()) {
      return;
    }
    if (Date.now() - start > TIMEOUT) {
      throw buildTimeoutError
        ? await buildTimeoutError()
        : new Error("Ready check timed out after 60s");
    }
    await sleep(POLL_INTERVAL);
  }
  // Aborted — return silently, caller checks controller.signal.aborted
}

/** Best-effort tail of the pane/log output, appended to enriched errors. */
async function capturePaneTail(deps: ReadyDeps, paneTarget: string): Promise<string> {
  try {
    const output = await deps.capturePane(paneTarget, TAIL_LINES);
    return output.trimEnd();
  } catch {
    return "";
  }
}

function withTail(message: string, tail: string): Error {
  return new Error(tail ? `${message}\n--- last output ---\n${tail}` : message);
}

/** Terminal docker states that should fail fast instead of waiting (B2). */
function isTerminalState(state: string): boolean {
  return state === "exited" || state === "dead";
}

async function waitForDocker(
  config: { docker: string | string[]; file?: string },
  paneTarget: string,
  signal: AbortSignal,
  deps: ReadyDeps,
): Promise<number[]> {
  if (!deps.dockerStatus) {
    throw new Error("Docker status dependency not provided");
  }
  const { dockerStatus } = deps;
  const file = config.file ?? deps.composeFile;
  const services = Array.isArray(config.docker) ? config.docker : [config.docker];
  const requireRecreate = deps.dockerRequireRecreate ?? false;
  let allPorts: number[] = [];
  let firstIds: string | undefined = undefined;
  let sawNotReady = false;
  let lastState = "";
  let terminalSince: number | undefined = undefined;

  await poll(
    async () => {
      const collected: number[] = [];
      const ids: string[] = [];
      let allReady = true;
      let terminal: { svc: string; state: string } | undefined = undefined;
      for (const svc of services) {
        const info = await dockerStatus(svc, deps.cwd, file);
        const ready = info !== null && isReady(info);
        if (info) {
          lastState = info.state;
          ids.push(...info.ids);
          if (isTerminalState(info.state)) {
            terminal ??= { svc, state: info.state };
          }
        }
        if (ready && info) {
          collected.push(...info.ports);
        }
        allReady &&= ready;
      }

      // Fail fast on a container that STAYS terminal (exited/dead) past the
      // Grace window (B2) — the grace ignores the transient `exited` shown while
      // A recreate/restart tears the old container down. Recreate-style starts
      // Skip this entirely (teardown is expected).
      if (!requireRecreate && terminal) {
        terminalSince ??= Date.now();
        if (Date.now() - terminalSince > TERMINAL_GRACE) {
          throw withTail(
            `Docker service '${terminal.svc}' exited (state: ${terminal.state}) before becoming ready`,
            await capturePaneTail(deps, paneTarget),
          );
        }
      } else {
        terminalSince = undefined;
      }

      const idKey = [...new Set(ids)].toSorted().join(",");
      firstIds ??= idKey;
      if (!allReady) {
        sawNotReady = true;
        return false;
      }
      // B4: a leftover container left running from a previous session satisfies
      // IsReady on the first poll, before `up --build/--force-recreate/-V`
      // Recreates it. Require the container id set to change (or a not-ready
      // Observation) before trusting ready. Skip when ids are unavailable
      // (can't detect recreate) or for non-recreate starts.
      // Known limitation: with build:true + an unchanged image + a still-running
      // Leftover container, the id never changes, so this waits out the full
      // Timeout and reports a (misleading) timeout on a healthy container —
      // Tracked for a StartedAt-based fix.
      if (requireRecreate && ids.length > 0 && idKey === firstIds && !sawNotReady) {
        return false;
      }
      allPorts = [...new Set(collected)].toSorted((a, b) => a - b);
      return true;
    },
    signal,
    async () =>
      withTail(
        `Docker ready check timed out after 60s${lastState ? ` (last container state: ${lastState})` : ""}`,
        await capturePaneTail(deps, paneTarget),
      ),
  );

  return allPorts;
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

  const timeoutError = async (): Promise<Error> =>
    withTail("Ready check timed out after 60s", await capturePaneTail(deps, paneTarget));

  if (isReadyDocker(config)) {
    return waitForDocker(config, paneTarget, signal, deps);
  }

  if (isReadyPort(config)) {
    if (config.port === true) {
      await poll(
        async () => {
          const ports = await deps.detectPorts(paneTarget);
          return ports.length > 0;
        },
        signal,
        timeoutError,
      );
    } else {
      const expectedPort = typeof config.port === "function" ? config.port() : config.port;
      await poll(
        async () => {
          const ports = await deps.detectPorts(paneTarget);
          return ports.includes(expectedPort);
        },
        signal,
        timeoutError,
      );
    }
    return [];
  }

  if (isReadyHttp(config)) {
    const normalized = typeof config.http === "string" ? { url: config.http } : config.http;
    const { url } = normalized;
    const hasStatus = typeof normalized.status === "number";
    const isPath = url.startsWith("/");

    const checkResponse = (res: Response) => (hasStatus ? res.status === normalized.status : true);

    // B7: path mode re-detects ports every poll and probes the path on all
    // Candidate ports (debugger/HMR ports skipped) — never lock onto ports[0].
    // Full-URL mode probes the URL directly.
    const probePath = async (): Promise<boolean> => {
      const ports = selectProbeCandidates(await deps.detectPorts(paneTarget));
      for (const port of ports) {
        try {
          const res = await fetch(`http://127.0.0.1:${String(port)}${url}`, {
            method: "GET",
            signal: AbortSignal.timeout(1000),
            redirect: "manual",
          });
          if (checkResponse(res)) {
            return true;
          }
        } catch {
          // Not ready on this port yet.
        }
      }
      return false;
    };
    const probeUrl = async (): Promise<boolean> => {
      try {
        const res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(1000),
          redirect: "manual",
        });
        return checkResponse(res);
      } catch {
        return false;
      }
    };

    await poll(isPath ? probePath : probeUrl, signal, timeoutError);
    return [];
  }

  if (isReadyOutput(config)) {
    await poll(
      async () => {
        const output = await deps.capturePane(paneTarget, 200);
        const lines = output.split("\n");
        const matcher = config.output;
        if (matcher instanceof RegExp) {
          // Reset lastIndex per test — a stray g/y flag (should be stripped at
          // Load, C10) would otherwise make matches stateful and flaky.
          return lines.some((line) => {
            matcher.lastIndex = 0;
            return matcher.test(line);
          });
        }
        return lines.some(matcher);
      },
      signal,
      timeoutError,
    );
    return [];
  }

  // Function mode
  if (typeof config === "function") {
    await poll(config, signal, timeoutError);
  }

  return [];
}
