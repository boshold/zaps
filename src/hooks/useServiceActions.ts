import type { DockerConfig } from "#src/config/types.js";
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

  async function rebuildDocker(name: string, overrides: Partial<DockerConfig>) {
    await manager.restartWithDockerOverrides(name, overrides);
  }

  return { restart, toggle, restartAll, rebuildDocker };
}
