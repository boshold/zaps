import type { ServiceManager } from "#src/lib/service/manager.js";

export function useServiceActions(manager: ServiceManager) {
  async function restart(name: string) {
    await manager.restartService(name);
  }

  async function toggle(name: string) {
    const status = manager.getStatus(name);
    if (status.state === "ready" || status.state === "starting") {
      await manager.stopService(name);
    } else {
      await manager.startService(name);
    }
  }

  async function restartAll() {
    await manager.stopAll();
    await manager.startAll();
  }

  return { restart, toggle, restartAll };
}
