import open from "open";

export async function openInBrowser(url: string): Promise<void> {
  try {
    await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(2000),
    });
    await open(url);
  } catch {
    // Not reachable — silently ignore
  }
}
