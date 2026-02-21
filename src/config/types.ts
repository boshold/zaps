import type { NodeModules } from "./node.js";
export type { NodeModules } from "./node.js";

// === Commands ===
export type Command = string | (() => string);

// === Ready Detection ===
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
export interface ReadyHttp {
  http: string | { url: string; status?: number };
}
export type ReadyConfig = ReadyFn | ReadyOutput | ReadyPort | ReadyDocker | ReadyHttp;

// === Docker Config ===
export interface DockerConfig {
  service: string;
  file?: string;
  build?: boolean;
  forceRecreate?: boolean;
  renewVolumes?: boolean;
  removeOrphans?: boolean;
  pull?: "always" | "missing" | "never";
  noDeps?: boolean;
}

// === Service Context ===
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

// === Env Config ===
export type EnvConfig = Record<string, string> | ((ctx: ServiceContext) => Record<string, string>);

// === Service Flags ===
export interface ServiceFlags {
  start?: boolean;
  open?: boolean;
}

// === Service ===
export interface ServiceConfig {
  start?: Command;
  run?: Command;
  stop?: Command;
  detached?: boolean;
  docker?: DockerConfig;
  ready?: ReadyConfig;
  dependsOn?: string[];
  env?: EnvConfig;
  flags?: ServiceFlags;
  url?: string | false | ((ctx: ServiceContext) => string);
  cwd?: string;
  restart?: { maxRetries?: number; backoff?: number };
  onBeforeStart?: () => void | Promise<void>;
  onReady?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  onOutput?: (line: string) => void | Promise<void>;
}

// === Task Run Context ===
export interface ExecResult {
  success: boolean;
  exitCode: number;
  output: string[];
}

export interface TaskRunContext {
  exec(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<ExecResult>;
  stdout: { write(text: string): void };
  services: ServiceContext;
  projectDir: string;
}

// === Tasks ===
export interface TaskConfig {
  name: string;
  description?: string;
  commands?: Command | Command[];
  run?: (ctx: TaskRunContext) => Promise<void>;
  popup?: boolean | { width?: string; height?: string };
  cwd?: string;
  dependsOn?: string[];
  env?: EnvConfig;
  shortcut?: string;
}

// === Layout ===
export interface LayoutLeaf {
  pane: string;
  size?: string;
  focus?: boolean;
}
export interface LayoutSplit {
  direction: "rows" | "columns";
  children: LayoutNode[];
  size?: string;
}
export type LayoutNode = LayoutLeaf | LayoutSplit;

// === Hooks ===
export interface HooksConfig {
  onBeforeStart?: () => void | Promise<void>;
  onStart?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
}

// === Cwd Context ===
export interface CwdContext {
  configDir: string;
  invokeDir: string;
}

// === Project ===
export interface ProjectConfig {
  name?: string;
  cwd?: string | ((ctx: CwdContext) => string);
  services: Record<string, ServiceConfig>;
  tasks?: Record<string, TaskConfig>;
  layout?: LayoutNode;
  hooks?: HooksConfig;
}

// === Library ===
export interface Library {
  defineProject(this: void, config: ProjectConfig): ProjectConfig;
  runTask(this: void, key: string): Promise<void>;
  startService(this: void, name: string): Promise<void>;
  restartService(this: void, name: string): Promise<void>;
  stopService(this: void, name: string): Promise<void>;
  isServiceRunning(this: void, name: string): boolean;
  openInBrowser(this: void, url: string): Promise<void>;
  node: NodeModules;
}

// === Library Actions ===
export interface LibraryActions {
  runTask: (key: string) => Promise<void>;
  startService: (name: string) => Promise<void>;
  restartService: (name: string) => Promise<void>;
  stopService: (name: string) => Promise<void>;
  isServiceRunning: (name: string) => boolean;
  openInBrowser: (url: string) => Promise<void>;
}

// === Resolved ===
export interface ResolvedConfig {
  project: ProjectConfig & { name: string };
  configPath: string;
  projectDir: string;
  bindActions?: (actions: LibraryActions) => void;
}

// === Type Guards ===
export function isLayoutLeaf(node: LayoutNode): node is LayoutLeaf {
  return "pane" in node;
}

export function isLayoutSplit(node: LayoutNode): node is LayoutSplit {
  return "children" in node;
}

export function isReadyPort(r: ReadyConfig): r is ReadyPort {
  return typeof r === "object" && "port" in r;
}

export function isReadyOutput(r: ReadyConfig): r is ReadyOutput {
  return typeof r === "object" && "output" in r;
}

export function isReadyDocker(r: ReadyConfig): r is ReadyDocker {
  return typeof r === "object" && "docker" in r;
}

export function isReadyHttp(r: ReadyConfig): r is ReadyHttp {
  return typeof r === "object" && "http" in r;
}
