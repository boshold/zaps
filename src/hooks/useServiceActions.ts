import type { DaemonClient } from "#src/client/daemon-client.js";
import type { DockerConfig } from "#src/config/types.js";

// Docker rebuild not yet supported via daemon — stub
async function rebuildDocker(_name: string, _overrides: Partial<DockerConfig>) {
  // TODO: Add docker rebuild support to daemon protocol
}

export function useServiceActions(client: DaemonClient) {
  async function restart(name: string) {
    await client.restartService(name);
  }

  async function toggle(name: string) {
    const statuses = await client.listServices();
    const svc = statuses.find((s) => s.name === name);
    if (svc?.state === "ready" || svc?.state === "starting") {
      await client.stopService(name);
    } else {
      await client.startService(name);
    }
  }

  async function restartAll() {
    await client.restartAll();
  }

  return { restart, toggle, restartAll, rebuildDocker };
}
