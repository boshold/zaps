import type { DockerContainerInfo } from "#src/lib/docker.js";

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
}

// === Service Context (local mirror of config/types ServiceContext) ===
export interface ServiceContext {
  services: Record<
    string,
    {
      port: number | undefined;
      ports: number[];
      cwd: string | undefined;
    }
  >;
  projectDir: string;
}

// === Env types ===
export type EnvConfig = Record<string, string> | ((ctx: ServiceContext) => Record<string, string>);

// === Ready Detection types ===
export type ReadyFn = () => Promise<boolean>;

export interface ReadyOutput {
  output: RegExp | ((line: string) => boolean);
}

export interface ReadyPort {
  port: number | true | (() => number);
}

export interface ReadyDocker {
  docker: string;
  file?: string;
}

export type ReadyConfig = ReadyFn | ReadyOutput | ReadyPort | ReadyDocker;

export function isReadyPort(r: ReadyConfig): r is ReadyPort {
  return typeof r === "object" && "port" in r;
}

export function isReadyOutput(r: ReadyConfig): r is ReadyOutput {
  return typeof r === "object" && "output" in r;
}

export function isReadyDocker(r: ReadyConfig): r is ReadyDocker {
  return typeof r === "object" && "docker" in r;
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
