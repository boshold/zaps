import { z } from "zod";

import type {
  CwdContext,
  LayoutSplit,
  OptionalContext,
  ServiceContext,
  TaskRunContext,
  UiConfig,
} from "./types.js";

// === Commands ===
const commandSchema = z.union([z.string(), z.custom<() => string>((v) => typeof v === "function")]);

// === Ready Detection ===
const readyFnSchema = z.custom<() => Promise<boolean>>((v) => typeof v === "function");

const readyOutputSchema = z.object({
  output: z.union([
    z.custom<RegExp>((v) => v instanceof RegExp),
    z.custom<(line: string) => boolean>((v) => typeof v === "function"),
  ]),
});

const readyPortSchema = z.object({
  port: z.union([
    z.number(),
    z.literal(true),
    z.custom<() => number>((v) => typeof v === "function"),
  ]),
});

const readyDockerSchema = z.object({
  docker: z.union([z.string(), z.array(z.string()).nonempty()]),
  file: z.optional(z.string()),
});

const readyHttpSchema = z.object({
  http: z.union([
    z.string(),
    z.object({
      url: z.string(),
      status: z.optional(z.number()),
    }),
  ]),
});

const readyConfigSchema = z.union([
  readyFnSchema,
  readyOutputSchema,
  readyPortSchema,
  readyDockerSchema,
  readyHttpSchema,
]);

// === Docker Config ===
const dockerConfigSchema = z.object({
  service: z.union([z.string(), z.array(z.string()).nonempty()]),
  file: z.optional(z.string()),
  projectName: z.optional(z.string()),
  build: z.optional(z.boolean()),
  forceRecreate: z.optional(z.boolean()),
  renewVolumes: z.optional(z.boolean()),
  removeOrphans: z.optional(z.boolean()),
  pull: z.optional(z.enum(["always", "missing", "never"])),
  noDeps: z.optional(z.boolean()),
  expand: z.optional(
    z.union([z.boolean(), z.record(z.string(), z.record(z.string(), z.unknown()))]),
  ),
});

// === Env Config ===
const envConfigSchema = z.union([
  z.record(z.string(), z.string()),
  z.custom<(ctx: ServiceContext) => Record<string, string>>((v) => typeof v === "function"),
]);

// === URL Config ===
const urlConfigSchema = z.union([
  z.string(),
  z.literal(false),
  z.custom<(ctx: ServiceContext) => string>((v) => typeof v === "function"),
]);

// === Service Flags ===
const flagsSchema = z.object({
  start: z.optional(z.boolean()),
  open: z.optional(z.boolean()),
});

// === Service Config ===
const serviceConfigBaseSchema = z.object({
  start: z.optional(commandSchema),
  run: z.optional(commandSchema),
  stop: z.optional(commandSchema),
  detached: z.optional(z.boolean()),
  lazyPane: z.optional(z.boolean()),
  docker: z.optional(dockerConfigSchema),
  ready: z.optional(readyConfigSchema),
  dependsOn: z.optional(z.array(z.string())),
  restartWith: z.optional(z.array(z.string())),
  env: z.optional(envConfigSchema),
  flags: z.optional(flagsSchema),
  url: z.optional(urlConfigSchema),
  cwd: z.optional(z.string()),
  raw: z.optional(z.boolean()),
  restart: z.optional(
    z.object({
      maxRetries: z.optional(z.number()),
      backoff: z.optional(z.number()),
    }),
  ),
  optional: z.optional(
    z.union([
      z.boolean(),
      z.custom<(ctx: OptionalContext) => boolean | Promise<boolean>>(
        (v) => typeof v === "function",
      ),
    ]),
  ),
  onBeforeStart: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
  onReady: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
  onStop: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
  onOutput: z.optional(
    z.custom<(line: string) => void | Promise<void>>((v) => typeof v === "function"),
  ),
});

type ServiceConfigInput = z.infer<typeof serviceConfigBaseSchema>;

/**
 * Detached services run pane-less, so any field that requires a tmux pane is a
 * load error (E4). Group-membership and layout checks live in the loader, where
 * the expanded group structure is known.
 */
function detachedIssues(name: string, svc: ServiceConfigInput): string[] {
  if (!svc.detached) {
    return [];
  }
  const issues: string[] = [];
  if (svc.docker) {
    issues.push(
      `Service '${name}': 'detached: true' cannot be combined with 'docker' — detached services run pane-less and have no docker pane. Remove one.`,
    );
  }
  if (svc.raw) {
    issues.push(
      `Service '${name}': 'detached: true' cannot be combined with 'raw' — raw mode sends keystrokes to a tmux pane, which detached services do not have. Remove one.`,
    );
  }
  if (!svc.start && !svc.run) {
    issues.push(
      `Service '${name}': 'detached: true' requires a 'start' or 'run' command to spawn (there is nothing to run otherwise).`,
    );
  }
  return issues;
}

/** Every non-detached service needs a start, run, or docker config to do anything. */
function baseCommandIssues(name: string, svc: ServiceConfigInput): string[] {
  if (!svc.detached && !svc.start && !svc.run && !svc.docker) {
    return [`Service '${name}' must have 'start', 'run', or 'docker' config`];
  }
  return [];
}

/**
 * Docker-only ready rejection (B3). Never fires for detached services: they have
 * no docker pane and PID-based port detection works for them.
 */
function dockerReadyIssues(name: string, svc: ServiceConfigInput): string[] {
  if (svc.detached || !svc.docker || !svc.ready || typeof svc.ready !== "object") {
    return [];
  }
  const { ready } = svc;
  const httpValue = "http" in ready ? ready.http : undefined;
  const httpUrl = typeof httpValue === "string" ? httpValue : httpValue?.url;
  const isHttpPath = typeof httpUrl === "string" && httpUrl.startsWith("/");
  if ("port" in ready || isHttpPath) {
    return [
      `Service '${name}': ready.port / ready.http path cannot be used with docker services (published ports belong to dockerd, not the pane, so they are never detected). Use docker readiness (default healthcheck/running detection) or ready: {http: "http://127.0.0.1:<port>/path"} with a full URL.`,
    ];
  }
  return [];
}

/**
 * `lazyPane: true` services start pane-less and acquire their pane only on
 * Explicit start (Flow B). `detached: true` services NEVER own a pane (they
 * Run process-only) — the combination is contradictory, so reject as a load
 * Error here. Docker-group-membership rejection lives in the loader where
 * `_combined` expansion is known (P04-T01 NOTE in the task file).
 */
function lazyPaneIssues(name: string, svc: ServiceConfigInput): string[] {
  if (svc.lazyPane !== true) {
    return [];
  }
  const issues: string[] = [];
  if (svc.detached) {
    issues.push(
      `Service '${name}': 'lazyPane: true' cannot be combined with 'detached: true' — a detached service has no pane.`,
    );
  }
  return issues;
}

/** `optional: true` needs a string command so the binary-availability probe can run. */
function optionalIssues(name: string, svc: ServiceConfigInput): string[] {
  if (svc.optional !== true) {
    return [];
  }
  const cmd = svc.start ?? svc.run;
  if (!cmd || typeof cmd !== "string") {
    return [
      `Service '${name}' has optional: true but requires 'start' or 'run' as a string; use optional: (ctx) => ctx.hasBinary('name') for function commands`,
    ];
  }
  return [];
}

const servicesSchema = z.record(z.string(), serviceConfigBaseSchema).superRefine((val, ctx) => {
  const entries = Object.entries(val);
  if (entries.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "Project must have at least one service",
      input: val,
    });
    return;
  }
  for (const [name, svc] of entries) {
    const issues = [
      ...detachedIssues(name, svc),
      ...lazyPaneIssues(name, svc),
      ...baseCommandIssues(name, svc),
      ...dockerReadyIssues(name, svc),
      ...optionalIssues(name, svc),
    ];
    for (const message of issues) {
      ctx.addIssue({ code: "custom", message, input: svc });
    }
  }
});

// === Tasks ===
const taskRunFnSchema = z.custom<(ctx: TaskRunContext) => Promise<void>>(
  (v) => typeof v === "function",
);

const taskConfigSchema = z
  .object({
    name: z.string(),
    description: z.optional(z.string()),
    commands: z.optional(z.union([commandSchema, z.array(commandSchema)])),
    run: z.optional(taskRunFnSchema),
    popup: z.optional(
      z.union([
        z.boolean(),
        z.object({ width: z.optional(z.string()), height: z.optional(z.string()) }),
      ]),
    ),
    cwd: z.optional(z.string()),
    dependsOn: z.optional(z.array(z.string())),
    env: z.optional(envConfigSchema),
    shortcut: z.optional(z.string()),
  })
  .superRefine((val, ctx) => {
    if (val.commands && val.run) {
      ctx.addIssue({
        code: "custom",
        message: "Task must have either 'commands' or 'run', not both",
        input: val,
      });
    }
    if (!val.commands && !val.run) {
      ctx.addIssue({
        code: "custom",
        message: "Task must have either 'commands' or 'run'",
        input: val,
      });
    }
    if (val.popup && val.run) {
      ctx.addIssue({
        code: "custom",
        message: "Task 'popup' can only be used with 'commands', not 'run'",
        input: val,
      });
    }
  });

// === Layout ===
const layoutLeafSchema = z.object({
  pane: z.string(),
  size: z.optional(z.string()),
  focus: z.optional(z.boolean()),
});

const layoutSplitSchema: z.ZodType<LayoutSplit> = z.object({
  direction: z.enum(["rows", "columns"]),
  get children() {
    return z.array(z.union([layoutLeafSchema, layoutSplitSchema]));
  },
  size: z.optional(z.string()),
});

const layoutNodeSchema = z.union([layoutLeafSchema, layoutSplitSchema]);

// === Hooks ===
const hooksConfigSchema = z.object({
  onBeforeStart: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
  onStart: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
  onStop: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
});

// === Cwd Config ===
const cwdConfigSchema = z.union([
  z.string(),
  z.custom<(ctx: CwdContext) => string>((v) => typeof v === "function"),
]);

// === UI Config ===
// TUI-local presentation. Every field defaults, and the whole block defaults to
// `{}` so omitting `ui` (or any field) resolves to the safe defaults. Consumers
// (IconTheme, DetailPane, notifications) land in later phases.
const uiTaskConfigSchema = z.object({
  defaultMode: z.enum(["background", "pane"]).default("background"),
  // Opt-in alternative picker: open `fzf` in a tmux popup instead of the in-app
  // TaskPicker. Falls back to the in-app picker when tmux < 3.2 or fzf is absent.
  popupPicker: z.boolean().default(false),
});

export const uiConfigSchema = z.object({
  icons: z.enum(["nerd", "unicode", "ascii"]).default("nerd"),
  notifications: z.enum(["off", "bell", "osc9", "osc9+bell"]).default("osc9"),
  failOutput: z.enum(["overlay", "popup"]).default("overlay"),
  // Prefault (not default) so an omitted `task` is parsed through the schema and
  // Picks up `defaultMode`, rather than being left as a bare `{}`.
  task: uiTaskConfigSchema.prefault({}),
  wideThreshold: z.number().int().min(40).default(100),
});

/** Fully-resolved UI config — every field present (the schema applies defaults). */
export type ResolvedUiConfig = z.infer<typeof uiConfigSchema>;

/**
 * Resolve a possibly-partial/absent UI config to one with every field present,
 * so consumers (IconTheme, DetailPane, notifications) read concrete values
 * instead of re-applying `?? default` fallbacks everywhere.
 */
export function resolveUiConfig(ui?: UiConfig): ResolvedUiConfig {
  return uiConfigSchema.parse(ui ?? {});
}

// === Project Config ===
export const projectConfigSchema = z.object({
  name: z.optional(z.string()),
  cwd: z.optional(cwdConfigSchema),
  services: servicesSchema,
  tasks: z.optional(z.record(z.string(), taskConfigSchema)),
  layout: z.optional(layoutNodeSchema),
  hooks: z.optional(hooksConfigSchema),
  // Prefault so an omitted `ui` block resolves to the full set of field defaults.
  ui: uiConfigSchema.prefault({}),
});

/**
 * Strict schema for a docker `expand` per-child override (G7). An override is
 * spread onto the inherited service, so it may set any service field EXCEPT the
 * command/lifecycle keys: `start`/`run` would silently replace the inherited
 * command, `docker` is silently discarded (the child gets its own docker config),
 * and `_combined` is internal. `.strict()` also rejects typos like `redy:` that
 * would otherwise be silently inert. Forbidden/unknown keys surface as a
 * load-time error naming the group, child, and offending key.
 */
export const expandOverrideSchema = serviceConfigBaseSchema
  .omit({ start: true, run: true, docker: true })
  .strict();
