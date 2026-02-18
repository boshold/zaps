const HTTP_TIMEOUT = 1000;

async function probeOne(port: number): Promise<string | undefined> {
  try {
    const res = await fetch(`http://localhost:${port}`, {
      method: "GET",
      signal: AbortSignal.timeout(HTTP_TIMEOUT),
      redirect: "manual",
    });
    // Any HTTP response (even 4xx/5xx) means it's an HTTP server
    if (res.type !== "error") {
      return `http://localhost:${port}`;
    }
  } catch {
    // Not HTTP
  }
  return undefined; // eslint-disable-line no-undefined -- Explicit absence
}

/**
 * HTTP GET probe on each port. Returns the first URL that responds, or undefined.
 */
export async function probePort(ports: number[]): Promise<string | undefined> {
  for (const port of ports) {
    // eslint-disable-next-line no-await-in-loop -- Sequential probe, first wins
    const url = await probeOne(port);
    if (url) {
      return url;
    }
  }
  return undefined; // eslint-disable-line no-undefined -- Explicit absence
}
