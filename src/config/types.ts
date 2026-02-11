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
export type ReadyConfig = ReadyFn | ReadyOutput | ReadyPort | ReadyDocker;

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

// === Service ===
export interface ServiceConfig {
  start?: Command;
  run?: Command; // Alias for start — `start` takes precedence if both set
  stop?: Command;
  detached?: boolean; // Default false
  docker?: DockerConfig;
  ready?: ReadyConfig;
  dependsOn?: string[];
  env?: Record<string, string> | ((ctx: ServiceContext) => Record<string, string>);
  autostart?: boolean; // Default true
  url?: string | ((ctx: ServiceContext) => string);
  cwd?: string;
  restart?: { maxRetries?: number; backoff?: number };
}

// === Tasks ===
export interface TaskConfig {
  name: string;
  description?: string;
  commands: Command | Command[];
  cwd?: string;
  dependsOn?: string[];
  env?: Record<string, string> | ((ctx: ServiceContext) => Record<string, string>);
  shortcut?: string;
}

// === Layout ===
export interface LayoutLeaf {
  pane: string;
  size?: string;
}
export interface LayoutSplit {
  direction: "rows" | "columns";
  children: LayoutNode[];
  size?: string;
}
export type LayoutNode = LayoutLeaf | LayoutSplit;

// === Hooks ===
export interface HooksConfig {
  onStart?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  onServiceStart?: (serviceName: string) => void | Promise<void>;
  onServiceStop?: (serviceName: string) => void | Promise<void>;
}

// === Project ===
export interface ProjectConfig {
  name?: string;
  services: Record<string, ServiceConfig>;
  tasks?: Record<string, TaskConfig>;
  layout?: LayoutNode;
  hooks?: HooksConfig;
}

// === Library ===
export interface Library {
  defineProject(this: void, config: ProjectConfig): ProjectConfig;
}

// === Resolved ===
export interface ResolvedConfig {
  project: ProjectConfig & { name: string };
  configPath: string;
  projectDir: string;
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
