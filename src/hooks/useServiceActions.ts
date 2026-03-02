import type { DaemonClient } from "#src/client/daemon-client.js";
import type { DockerConfig } from "#src/config/types.js";

export function useServiceActions(client: DaemonClient) {
  async function rebuildDocker(name: string, overrides: Partial<DockerConfig>) {
    await client.rebuildDocker(name, overrides);
  }

  async function restart(name: string) {
    await client.restartService(name);
  }

  async function toggle(name: string) {
    const statuses = await client.listServices();
    const svc = statuses.find((s) => s.name === name);
    await (svc?.state === "ready" || svc?.state === "starting"
      ? client.stopService(name)
      : client.startService(name));
  }

  async function restartAll() {
    await client.restartAll();
  }

  return { restart, toggle, restartAll, rebuildDocker };
}
