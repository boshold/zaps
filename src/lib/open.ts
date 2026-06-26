import open from "open";

/**
 * Open a URL in the system's default browser. No reachability preflight — a
 * service that is still booting should still open (the browser retries). A real
 * failure (e.g. no browser available) rejects, so callers that have a notice
 * sink can surface it instead of swallowing silently (Q-R4a).
 */
export async function openInBrowser(url: string): Promise<void> {
  await open(url);
}
