/**
 * Module-level shutdown hook (D1). `runDaemon` registers the daemon teardown
 * here and the `daemon.shutdown` IPC handler invokes it. A module function is
 * used rather than a method on the server instance so the handler depends on a
 * stable binding, not a dynamically-assigned optional property.
 */
let shutdownHook: (() => Promise<void>) | null = null;

export function registerShutdownHook(fn: (() => Promise<void>) | null): void {
  shutdownHook = fn;
}

export async function runShutdownHook(): Promise<void> {
  await shutdownHook?.();
}
