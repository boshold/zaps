import { z } from "zod";

import type {
  BackendCapabilities,
  ExecutionEvent,
  PresentationSnapshot,
  ServiceActions,
} from "./types.js";

const backendIdSchema = z.enum(["tmux", "shell"]);
const backendCapabilitiesSchema = z.strictObject({
  panes: z.boolean(),
  zoom: z.boolean(),
  popups: z.boolean(),
  taskPanes: z.boolean(),
  rawInput: z.boolean(),
  layout: z.boolean(),
}) satisfies z.ZodType<BackendCapabilities>;
const serviceActionsSchema = z.strictObject({
  focus: z.boolean(),
  zoom: z.boolean(),
  editOutput: z.boolean(),
}) satisfies z.ZodType<ServiceActions>;

const shellCapabilitiesSchema = z.strictObject({
  panes: z.literal(false),
  zoom: z.literal(false),
  popups: z.literal(false),
  taskPanes: z.literal(false),
  rawInput: z.literal(false),
  layout: z.literal(false),
});
const tmuxMetadata = { backend: z.literal("tmux"), capabilities: backendCapabilitiesSchema };
const shellMetadata = { backend: z.literal("shell"), capabilities: shellCapabilitiesSchema };
const backendMetadataSchema = z.discriminatedUnion("backend", [
  z.strictObject(tmuxMetadata),
  z.strictObject(shellMetadata),
]);
type BackendMetadata = z.infer<typeof backendMetadataSchema>;

const nonblank = z.string().refine((value) => value.trim().length > 0, "Must not be blank");
const createCommon = {
  configPath: z.string(),
  projectDir: z.string(),
  resolvedProjectDir: z.string().optional(),
};
const sessionCreateParamsSchema = z.discriminatedUnion("backend", [
  z.strictObject({ ...createCommon, backend: z.literal("shell") }),
  z
    .strictObject({
      ...createCommon,
      backend: z.literal("tmux"),
      tmuxSession: nonblank,
      originPane: nonblank,
      tmuxSocket: nonblank.nullable().optional(),
      managedTmux: z.boolean().optional(),
    })
    .refine(
      (value) =>
        !value.managedTmux || (value.tmuxSocket !== null && value.tmuxSocket !== undefined),
      {
        message: "Managed tmux requires a named socket",
        path: ["tmuxSocket"],
      },
    ),
]);
type SessionCreateParams = z.infer<typeof sessionCreateParamsSchema>;

function normalizeLegacySessionCreateParams(input: unknown): SessionCreateParams {
  const params = z.record(z.string(), z.unknown()).parse(input);
  return sessionCreateParamsSchema.parse(
    Object.hasOwn(params, "backend") ? params : { ...params, backend: "tmux" },
  );
}

const sessionIdentity = { id: z.string(), name: z.string() };
const paneMap = z.record(z.string(), z.string());
const emptyPaneMap = z.strictObject({});
const sessionCreatedSchema = z.discriminatedUnion("backend", [
  z.strictObject({
    ...sessionIdentity,
    ...tmuxMetadata,
    paneMap,
    focusPane: z.string().optional(),
  }),
  z.strictObject({ ...sessionIdentity, ...shellMetadata, paneMap: emptyPaneMap }),
]);
type SessionCreated = z.infer<typeof sessionCreatedSchema>;
const listCommon = {
  ...sessionIdentity,
  configPath: z.string(),
  projectDir: z.string(),
  createdAt: z.number().finite(),
};
const sessionListEntrySchema = z.discriminatedUnion("backend", [
  z.strictObject({
    ...listCommon,
    ...tmuxMetadata,
    tmuxSession: z.string().optional(),
    managed: z.boolean().optional(),
    tuiPane: z.string().nullable().optional(),
  }),
  z.strictObject({ ...listCommon, ...shellMetadata }),
]);
type SessionListEntry = z.infer<typeof sessionListEntrySchema>;

const presentationSnapshotSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("shell") }),
  z.strictObject({
    kind: z.literal("tmux"),
    tmuxSession: z.string(),
    tmuxWindow: z.string(),
    originPane: z.string(),
    tmuxSocket: z.string().nullable(),
    managedTmux: z.boolean(),
    paneMap,
    focusPane: z.string().optional(),
  }),
]) satisfies z.ZodType<PresentationSnapshot>;

const executionIdentity = { unitId: z.string(), generation: z.number().int().nonnegative() };
const exitDetails = {
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  spawnError: z.string().optional(),
};
const executionEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...executionIdentity, ...exitDetails, kind: z.literal("leaderExit") }),
  z.strictObject({ ...executionIdentity, kind: z.literal("output"), lines: z.array(z.string()) }),
  z.strictObject({
    ...executionIdentity,
    ...exitDetails,
    kind: z.literal("exit"),
    cleanupError: z.string().optional(),
    drainTimedOut: z.boolean().optional(),
  }),
]) satisfies z.ZodType<ExecutionEvent>;

const backendErrorCodeSchema = z.enum([
  "invalid_request",
  "invalid_backend",
  "backend_conflict",
  "unsupported_capability",
  "unsupported_config",
  "backend_unavailable",
  "session_closing",
  "terminal_busy",
  "services_not_running",
  "service_start_failed",
  "service_unavailable",
]);
type BackendErrorCode = z.infer<typeof backendErrorCodeSchema>;
const ipcErrorResponseSchema = z.strictObject({
  id: z.string(),
  error: z.string(),
  errorCode: backendErrorCodeSchema.optional(),
});
type IpcErrorResponse = z.infer<typeof ipcErrorResponseSchema>;

const terminalTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("service"), name: z.string().min(1) }),
  z.strictObject({ kind: z.literal("dashboard") }),
]);
const terminalActionParamsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("focus"), target: terminalTargetSchema }),
  z.strictObject({ action: z.literal("zoom"), target: terminalTargetSchema }),
  z.strictObject({ action: z.literal("editOutput"), service: z.string().min(1) }),
  z.strictObject({ action: z.literal("taskPicker") }),
  z.strictObject({ action: z.literal("taskOutput"), runId: z.string().min(1) }),
]);
const terminalActionResultSchema = z.union([
  z.strictObject({ action: z.literal("taskPicker"), taskKey: z.string().nullable() }),
  z.strictObject({
    action: z.enum(["focus", "zoom", "editOutput", "taskOutput"]),
    done: z.literal(true),
  }),
]);
type TerminalActionParams = z.infer<typeof terminalActionParamsSchema>;
type TerminalActionResult = z.infer<typeof terminalActionResultSchema>;
export { terminalTargetSchema, terminalActionParamsSchema, terminalActionResultSchema };
export type { TerminalActionParams, TerminalActionResult };

export type {
  BackendMetadata,
  SessionCreateParams,
  SessionCreated,
  SessionListEntry,
  BackendErrorCode,
  IpcErrorResponse,
};
export {
  backendIdSchema,
  backendCapabilitiesSchema,
  serviceActionsSchema,
  backendMetadataSchema,
  sessionCreateParamsSchema,
  normalizeLegacySessionCreateParams,
  sessionCreatedSchema,
  sessionListEntrySchema,
  presentationSnapshotSchema,
  executionEventSchema,
  backendErrorCodeSchema,
  ipcErrorResponseSchema,
};
