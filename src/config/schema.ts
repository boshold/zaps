import type { LayoutSplit, ServiceContext } from "./types.js";
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
  docker: z.string(),
  file: z.optional(z.string()),
});

const readyConfigSchema = z.union([
  readyFnSchema,
  readyOutputSchema,
  readyPortSchema,
  readyDockerSchema,
]);

// === Docker Config ===
const dockerConfigSchema = z.object({
  service: z.string(),
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
  z.custom<(ctx: ServiceContext) => string>((v) => typeof v === "function"),
]);

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
  autostart: z.optional(z.boolean()),
  url: z.optional(urlConfigSchema),
  cwd: z.optional(z.string()),
  restart: z.optional(
    z.object({
      maxRetries: z.optional(z.number()),
      backoff: z.optional(z.number()),
    }),
  ),
  onReady: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
  onStop: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
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
const taskConfigSchema = z.object({
  name: z.string(),
  description: z.optional(z.string()),
  commands: z.union([commandSchema, z.array(commandSchema)]),
  cwd: z.optional(z.string()),
  dependsOn: z.optional(z.array(z.string())),
  env: z.optional(envConfigSchema),
  shortcut: z.optional(z.string()),
});

// === Layout ===
const layoutLeafSchema = z.object({
  pane: z.string(),
  size: z.optional(z.string()),
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
  onStart: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
  onStop: z.optional(z.custom<() => void | Promise<void>>((v) => typeof v === "function")),
  onServiceStart: z.optional(
    z.custom<(serviceName: string) => void | Promise<void>>((v) => typeof v === "function"),
  ),
  onServiceStop: z.optional(
    z.custom<(serviceName: string) => void | Promise<void>>((v) => typeof v === "function"),
  ),
});

// === Project Config ===
export const projectConfigSchema = z.object({
  name: z.optional(z.string()),
  services: servicesSchema,
  tasks: z.optional(z.record(z.string(), taskConfigSchema)),
  layout: z.optional(layoutNodeSchema),
  hooks: z.optional(hooksConfigSchema),
});
