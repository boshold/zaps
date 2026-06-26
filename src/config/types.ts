import type { NodeModules } from "./node.js";

export type { NodeModules } from "./node.js";

// === Commands ===
export type Command = string | ((ctx: ServiceContext) => string);

// === Ready Detection ===
export type ReadyFn = () => Promise<boolean>;
export interface ReadyOutput {
  output: RegExp | ((line: string) => boolean);
}
export interface ReadyPort {
  port: number | true | (() => number);
}
export interface ReadyDocker {
  docker: string | string[];
  file?: string;
}
export interface ReadyHttp {
  http: string | { url: string; status?: number };
}
export type ReadyConfig = ReadyFn | ReadyOutput | ReadyPort | ReadyDocker | ReadyHttp;

// === Docker Config ===
export interface DockerConfig {
  service: string | string[];
  file?: string;
  /** Pin the compose project name (overrides env / file `name:` / the zaps pin). */
  projectName?: string;
  build?: boolean;
  forceRecreate?: boolean;
  renewVolumes?: boolean;
  removeOrphans?: boolean;
  pull?: "always" | "missing" | "never";
  noDeps?: boolean;
  expand?: boolean | Record<string, ExpandChildOverrides>;
}

/** Per-child overrides for expanded docker services */
export type ExpandChildOverrides = Omit<
  Partial<ServiceConfig>,
  "docker" | "start" | "run" | "_combined"
>;

// === Combined Service Metadata ===
export interface CombinedServiceMeta {
  group: string;
  allServices: string[];
  isOwner: boolean;
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

// === Optional Context ===
export interface OptionalContext {
  hasBinary(name: string): Promise<boolean>;
}

// === Env Config ===
export type EnvValue = string | null | undefined;
export type EnvConfig =
  | Record<string, EnvValue>
  | ((ctx: ServiceContext) => Record<string, EnvValue>);

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
  /**
   * Opt out of getting a tmux pane at boot. The service starts pane-less and
   * Receives its pane only when explicitly started (Flow B). Implementing the
   * `applyDefaults` rule for this field is P04-T02; this is the type + schema
   * Field only.
   */
  lazyPane?: boolean;
  docker?: DockerConfig;
  ready?: ReadyConfig;
  dependsOn?: string[];
  restartWith?: string[];
  env?: EnvConfig;
  flags?: ServiceFlags;
  url?: string | false | ((ctx: ServiceContext) => string);
  cwd?: string;
  raw?: boolean;
  restart?: { maxRetries?: number; backoff?: number };
  onBeforeStart?: () => void | Promise<void>;
  onReady?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  onOutput?: (line: string) => void | Promise<void>;
  optional?: boolean | ((ctx: OptionalContext) => boolean | Promise<boolean>);
  /** @internal Set by loader for expanded docker services */
  _combined?: CombinedServiceMeta;
}

// === Unavailable Service Info ===
export interface UnavailableServiceInfo {
  name: string;
  reason: string;
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

// === UI Config ===
/** Icon theme tier; resolved at startup (Phase 2 `IconTheme`). */
export type UiIconTheme = "nerd" | "unicode" | "ascii";
/** Failure-notification channel (mirrors Claude Code's `notifier.ts` model). */
export type UiNotifications = "off" | "bell" | "osc9" | "osc9+bell";
/** Default target when opening failed task output (escalation always available). */
export type UiFailOutput = "overlay" | "popup";
/** Default task launch mode. */
export type UiTaskMode = "background" | "pane";

export interface UiTaskConfig {
  defaultMode?: UiTaskMode;
  /** Open the picker as `fzf` in a tmux popup (falls back to the in-app picker). */
  popupPicker?: boolean;
}

/** TUI-local presentation config. Every field is optional and has a safe default. */
export interface UiConfig {
  icons?: UiIconTheme;
  notifications?: UiNotifications;
  failOutput?: UiFailOutput;
  task?: UiTaskConfig;
  /** Min cols to show the detail pane (Q2). Integer ≥ 40. */
  wideThreshold?: number;
}

// === Project ===
export interface ProjectConfig {
  name?: string;
  cwd?: string | ((ctx: CwdContext) => string);
  services: Record<string, ServiceConfig>;
  tasks?: Record<string, TaskConfig>;
  layout?: LayoutNode;
  hooks?: HooksConfig;
  ui?: UiConfig;
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
  /** Maps group name → expanded child service names (from docker expand) */
  groups: Map<string, string[]>;
  unavailableServices: Map<string, UnavailableServiceInfo>;
  /**
   * Resolved per-service `lazyPane` boolean (P04-T02). Computed ONCE here so the
   * Manager + `createLayout` never re-derive the rule. The exact rule, with the
   * Group/detached guard applied FIRST:
   *
   *   (svc.detached || svc._combined != null) ? false
   *                                           : (svc.lazyPane ?? (flags.start === false))
   *
   * Group members share a pane and detached services own no pane — `true` would
   * Drive a spurious separate-pane insert (P04-T04) or a desynced boot-skip
   * (P04-T03), so the guard forces `false` even if the user explicitly set
   * `lazyPane: true` (the LOAD error for that case is P04-T01's job; this map
   * Refuses to emit `true` in either situation).
   */
  lazyPaneByService: Map<string, boolean>;
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
