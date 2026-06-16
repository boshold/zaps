const HTTP_TIMEOUT = 1000;

const AUX_PORT_RANGE_START = 9229;
const AUX_PORT_RANGE_END = 9240;
const VITE_HMR_PORT = 24_678;

/**
 * Ports that speak HTTP but are never the application: the Node inspector
 * (9229-9240) and the Vite HMR/dev socket (24678). They sort below typical app
 * ports, so the lowest-port heuristic locks onto them (B7).
 */
function isAuxPort(port: number): boolean {
  return port === VITE_HMR_PORT || (port >= AUX_PORT_RANGE_START && port <= AUX_PORT_RANGE_END);
}

/**
 * Non-aux ports if any exist, otherwise the original list — never brick a
 * service that genuinely listens only on an aux port (B7).
 */
function selectProbeCandidates(ports: number[]): number[] {
  const primary = ports.filter((p) => !isAuxPort(p));
  return primary.length > 0 ? primary : ports;
}

async function fetchProbe(host: string, port: number): Promise<Response | undefined> {
  try {
    const res = await fetch(`http://${host}:${port}`, {
      method: "GET",
      signal: AbortSignal.timeout(HTTP_TIMEOUT),
      redirect: "manual",
    });
    // Any HTTP response (even 4xx/5xx) means it's an HTTP server.
    return res.type === "error" ? undefined : res;
  } catch {
    return undefined;
  }
}

/** Probe one port on `127.0.0.1`, falling back to `[::1]` (B8). */
async function probeOne(port: number): Promise<{ url: string; ok: boolean } | undefined> {
  for (const host of ["127.0.0.1", "[::1]"]) {
    const res = await fetchProbe(host, port);
    if (res) {
      return { url: `http://${host}:${port}`, ok: res.status >= 200 && res.status < 400 };
    }
  }
  return undefined;
}

/**
 * HTTP GET probe across ports. Prefers a 2xx/3xx response — a port answering
 * only 4xx/5xx wins only if no port answers 2xx/3xx. Auxiliary debugger/HMR
 * ports are skipped unless they are the only ports available (B7). Targets
 * `127.0.0.1` with an `[::1]` fallback (B8).
 */
async function probePort(ports: number[]): Promise<string | undefined> {
  let fallback: string | undefined = undefined;
  for (const port of selectProbeCandidates(ports)) {
    const result = await probeOne(port);
    if (result?.ok) {
      return result.url;
    }
    fallback ??= result?.url;
  }
  return fallback;
}

export { probePort, isAuxPort, selectProbeCandidates };
