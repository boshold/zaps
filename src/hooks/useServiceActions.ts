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
    // Try stop; if fails (already stopped), start instead
    try {
      await client.stopService(name);
    } catch {
      await client.startService(name);
    }
  }

  async function restartAll() {
    const statuses = await client.listServices();
    for (const s of statuses) {
      // eslint-disable-next-line no-await-in-loop -- Sequential restart
      await client.restartService(s.name);
    }
  }

  return { restart, toggle, restartAll, rebuildDocker };
}
