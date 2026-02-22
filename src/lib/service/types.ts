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
} from "#src/config/types.js";
export { isReadyDocker, isReadyHttp, isReadyOutput, isReadyPort } from "#src/config/types.js";

// === Service State ===
export type ServiceState = "stopped" | "starting" | "ready" | "stopping" | "error" | "restarting";

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
}

export interface EnvDeps {
  setEnv: (session: string, key: string, value: string) => Promise<void>;
}
