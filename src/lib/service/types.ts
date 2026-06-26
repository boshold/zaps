import type { DockerContainerInfo } from "#src/lib/docker.js";

// Re-export shared types from config
export type {
  EnvConfig,
  ReadyConfig,
  ReadyDocker,
  ReadyFn,
  ReadyHttp,
  ReadyOutput,
  ReadyPort,
  ServiceContext,
  UrlOptions,
} from "#src/config/types.js";
export { isReadyDocker, isReadyHttp, isReadyOutput, isReadyPort } from "#src/config/types.js";

// === Exec Info ===
export interface ExecInfo {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

// === Service State ===
export type ServiceState =
  | "stopped"
  | "starting"
  | "ready"
  | "stopping"
  | "error"
  | "restarting"
  | "unavailable";

export interface ServiceStatus {
  name: string;
  state: ServiceState;
  ports: number[];
  url?: string;
  paneId?: string;
  pid?: number;
  retryCount: number;
  lastError?: string;
  readySince?: number;
  isDocker?: boolean;
  /** Pane-less service spawned by the DetachedRunner — drives the TUI marker (E4). */
  isDetached?: boolean;
  /** Group name for expanded docker services */
  group?: string;
}

// === Action results ===
/**
 * Result of an idempotent start/stop call. `noop` is true when the call was a
 * no-op because the service was already in a matching state (e.g. stopping an
 * already-stopped service), so callers/handlers can report "already done"
 * instead of an error.
 */
export interface ServiceActionResult {
  noop: boolean;
}

// === Dependency injection interfaces ===
export interface ReadyDeps {
  detectPorts: (paneTarget: string) => Promise<number[]>;
  capturePane: (target: string, lines: number) => Promise<string>;
  cwd?: string;
  composeFile?: string;
  dockerStatus?: (
    service: string,
    cwd?: string,
    composeFile?: string,
  ) => Promise<DockerContainerInfo | null>;
  /**
   * True for recreate-style docker starts (`build`/`forceRecreate`/
   * `renewVolumes`): a leftover container must be replaced before ready is
   * accepted, so the ready loop waits for the container id set to change (B4).
   */
  dockerRequireRecreate?: boolean;
}
