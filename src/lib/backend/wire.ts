import { z } from "zod";

import {
  backendCapabilitiesSchema,
  backendIdSchema,
  serviceActionsSchema,
  sessionListEntrySchema,
} from "./schemas.js";

const unavailableCapabilities = {
  panes: false,
  zoom: false,
  popups: false,
  taskPanes: false,
  rawInput: false,
  layout: false,
};
const unavailableActions = { focus: false, zoom: false, editOutput: false };

const statusFields = {
  name: z.string(),
  state: z.enum(["stopped", "starting", "ready", "stopping", "error", "restarting", "unavailable"]),
  ports: z.array(z.number()),
  url: z.string().optional(),
  paneId: z.string().optional(),
  pid: z.number().optional(),
  retryCount: z.number(),
  lastError: z.string().optional(),
  readySince: z.number().optional(),
  isDocker: z.boolean().optional(),
  isDetached: z.boolean().optional(),
  group: z.string().optional(),
  startedAt: z.number().optional(),
  sentra: z.boolean().optional(),
  errorCount: z.number().nullable().optional(),
  dependsOn: z.array(z.string()).optional(),
  hasDocker: z.boolean().optional(),
};
const projectedStatusSchema = z.object({ ...statusFields, actions: serviceActionsSchema });
const legacyStatusSchema = z.object(statusFields);
function parseServiceStatus(input: unknown, advertised = true) {
  const record = z.record(z.string(), z.unknown()).parse(input);
  const status = Object.hasOwn(record, "actions")
    ? projectedStatusSchema.parse(input)
    : { ...legacyStatusSchema.parse(input), actions: { ...unavailableActions } };
  return advertised ? status : { ...status, actions: { ...unavailableActions } };
}
const daemonEventDataSchemas = {
  stateChange: z.object({ name: z.string(), status: z.unknown() }),
  logLines: z.object({ service: z.string(), lines: z.array(z.string()) }),
  taskStart: z.object({ key: z.string(), name: z.string(), runId: z.string().optional() }),
  taskComplete: z.object({
    key: z.string(),
    name: z.string(),
    runId: z.string().optional(),
    result: z.enum(["success", "error"]),
  }),
  paneMap: z.object({ paneMap: z.record(z.string(), z.string()) }),
  notice: z.object({ level: z.enum(["info", "warn", "success"]), message: z.string() }),
};
const snapshotFields = {
  id: z.string(),
  name: z.string(),
  paneMap: z.record(z.string(), z.string()),
  statuses: z.array(projectedStatusSchema),
  logSnapshots: z.record(z.string(), z.array(z.string())),
  configPath: z.string(),
  projectDir: z.string(),
  tasks: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      shortcut: z.string().optional(),
    }),
  ),
  servicesMeta: z.array(
    z.object({
      name: z.string(),
      dependsOn: z.array(z.string()),
      hasDocker: z.boolean(),
      isDetached: z.boolean().optional(),
      group: z.string().optional(),
      dockerDefaults: z.object({
        build: z.boolean(),
        forceRecreate: z.boolean(),
        renewVolumes: z.boolean(),
        pull: z.boolean(),
        removeOrphans: z.boolean(),
      }),
    }),
  ),
  taskHistory: z.array(
    z.object({
      runId: z.string(),
      taskKey: z.string(),
      taskName: z.string(),
      result: z.enum(["running", "success", "error"]),
      timestamp: z.number(),
      mode: z.enum(["background", "pane"]).optional(),
      acknowledged: z.boolean().optional(),
    }),
  ),
  unavailableServices: z.array(z.object({ name: z.string(), reason: z.string() })),
  configStale: z.boolean(),
  ui: z
    .object({
      icons: z.enum(["nerd", "unicode", "ascii"]).optional(),
      notifications: z.enum(["off", "bell", "osc9", "osc9+bell"]).optional(),
      failOutput: z.enum(["overlay", "popup"]).optional(),
      task: z
        .object({
          defaultMode: z.enum(["background", "pane"]).optional(),
          popupPicker: z.boolean().optional(),
        })
        .optional(),
      wideThreshold: z.number().optional(),
    })
    .optional(),
};
const shellCapabilities = backendCapabilitiesSchema.refine((value) =>
  Object.values(value).every((flag) => !flag),
);
const sessionSnapshotSchema = z.discriminatedUnion("backend", [
  z.strictObject({
    ...snapshotFields,
    backend: z.literal("shell"),
    capabilities: shellCapabilities,
    paneMap: z.strictObject({}),
    statuses: z.array(
      projectedStatusSchema.refine(
        (status) =>
          status.paneId === undefined && Object.values(status.actions).every((action) => !action),
      ),
    ),
  }),
  z.strictObject({
    ...snapshotFields,
    backend: z.literal("tmux"),
    capabilities: backendCapabilitiesSchema,
    tmuxSession: z.string(),
    managed: z.boolean(),
    originPane: z.string(),
  }),
]);
function parseSessionSnapshot(input: unknown, advertised = true) {
  const record = z.record(z.string(), z.unknown()).parse(input);
  const legacy = !Object.hasOwn(record, "backend") && !Object.hasOwn(record, "capabilities");
  const statuses = z
    .array(z.unknown())
    .parse(record.statuses)
    .map((status) =>
      legacy ? parseServiceStatus(status, false) : projectedStatusSchema.parse(status),
    );
  const snapshot = sessionSnapshotSchema.parse({
    ...record,
    statuses,
    ...(legacy ? { backend: "tmux", capabilities: { ...unavailableCapabilities } } : {}),
  });
  if (!advertised) {
    snapshot.capabilities = { ...unavailableCapabilities };
    for (const status of snapshot.statuses) {
      status.actions = { ...unavailableActions };
    }
  }
  return snapshot;
}
const legacyListSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectDir: z.string(),
  configPath: z.string().optional(),
  createdAt: z.number().finite().optional(),
  tmuxSession: z.string().optional(),
  managed: z.boolean().optional(),
  tuiPane: z.string().nullable().optional(),
});
function parseSessionListEntry(input: unknown) {
  const record = z.record(z.string(), z.unknown()).parse(input);
  if (Object.hasOwn(record, "backend") || Object.hasOwn(record, "capabilities")) {
    return sessionListEntrySchema.parse(input);
  }
  return {
    ...legacyListSchema.parse(input),
    backend: "tmux" as const,
    capabilities: { ...unavailableCapabilities },
  };
}
function parseSessionList(input: unknown) {
  return z.array(z.unknown()).parse(input).map(parseSessionListEntry);
}

const daemonStatusSchema = z.object({
  pid: z.number().int(),
  supportedBackends: z.array(backendIdSchema).optional(),
  sessions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      configPath: z.string(),
      projectDir: z.string(),
      serviceCount: z.number(),
      subscriberCount: z.number(),
      createdAt: z.number(),
    }),
  ),
});
function parseDaemonStatus(input: unknown) {
  const record = z.record(z.string(), z.unknown()).parse(input);
  if (Object.hasOwn(record, "supportedBackends")) {
    z.array(backendIdSchema).parse(record.supportedBackends);
  }
  const status = daemonStatusSchema.parse(input);
  return {
    ...status,
    advertised: status.supportedBackends !== undefined,
    supportedBackends: status.supportedBackends ?? [backendIdSchema.parse("tmux")],
  };
}

export {
  daemonEventDataSchemas,
  unavailableCapabilities,
  unavailableActions,
  projectedStatusSchema,
  parseServiceStatus,
  sessionSnapshotSchema,
  parseSessionSnapshot,
  parseSessionListEntry,
  parseSessionList,
  daemonStatusSchema,
  parseDaemonStatus,
};
