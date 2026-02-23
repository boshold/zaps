import type { CwdContext, LayoutSplit, ServiceContext, TaskRunContext } from "./types.js";
import { z } from "zod";

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
  build: z.optional(z.boolean()),
  forceRecreate: z.optional(z.boolean()),
  renewVolumes: z.optional(z.boolean()),
  removeOrphans: z.optional(z.boolean()),
  pull: z.optional(z.enum(["always", "missing", "never"])),
  noDeps: z.optional(z.boolean()),
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
  docker: z.optional(dockerConfigSchema),
  ready: z.optional(readyConfigSchema),
  dependsOn: z.optional(z.array(z.string())),
  env: z.optional(envConfigSchema),
  flags: z.optional(flagsSchema),
  url: z.optional(urlConfigSchema),
  cwd: z.optional(z.string()),
  restart: z.optional(
    z.object({
      maxRetries: z.optional(z.number()),
      backoff: z.optional(z.number()),
    }),
  ),
  onBeforeStart: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
  onReady: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
  onStop: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
  onOutput: z.optional(
    z.custom<(line: string) => void | Promise<void>>((v) => typeof v === "function"),
  ),
});

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
    if (!svc.start && !svc.run && !svc.docker) {
      ctx.addIssue({
        code: "custom",
        message: `Service '${name}' must have 'start', 'run', or 'docker' config`,
        input: svc,
      });
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

// === Project Config ===
export const projectConfigSchema = z.object({
  name: z.optional(z.string()),
  cwd: z.optional(cwdConfigSchema),
  services: servicesSchema,
  tasks: z.optional(z.record(z.string(), taskConfigSchema)),
  layout: z.optional(layoutNodeSchema),
  hooks: z.optional(hooksConfigSchema),
});
