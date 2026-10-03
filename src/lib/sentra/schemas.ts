import { ITEM_KINDS, LEVELS } from "@boshold/sentra-core";
import type { IssueDetail, Item } from "@boshold/sentra-core";
import { z } from "zod";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 20;

const sessionIdSchema = z.string().regex(/^[0-9a-f]{12}$/, "sessionId must be 12 hex chars");
const levelSchema = z.enum(LEVELS);
const itemKindSchema = z.enum(ITEM_KINDS);

function isRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

const timeValueSchema = z.union([z.string(), z.number()]);
const timeShape = {
  from: timeValueSchema.optional(),
  to: timeValueSchema.optional(),
  since: z.string().optional(),
};
const pageShape = {
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  skip: z.number().int().min(0).optional(),
};

export const statusParamsSchema = z.object({ sessionId: sessionIdSchema });

export const errorsParamsSchema = z.object({
  sessionId: sessionIdSchema,
  service: z.array(z.string()).min(1).optional(),
  kind: z.array(itemKindSchema).min(1).optional(),
  level: z.array(levelSchema).min(1).optional(),
  minLevel: levelSchema.optional(),
  q: z.string().optional(),
  release: z.string().optional(),
  environment: z.string().optional(),
  traceId: z.string().optional(),
  ...timeShape,
  ...pageShape,
});

export const issuesParamsSchema = z.object({
  sessionId: sessionIdSchema,
  service: z.array(z.string()).min(1).optional(),
  level: z.array(levelSchema).min(1).optional(),
  minLevel: levelSchema.optional(),
  q: z.string().optional(),
  ...timeShape,
  ...pageShape,
});

export const showParamsSchema = z.object({
  sessionId: sessionIdSchema,
  id: z.string().min(1),
});

export const clearParamsSchema = z.object({
  sessionId: sessionIdSchema,
  service: z.array(z.string()).min(1).optional(),
  to: timeValueSchema.optional(),
});

export const errorRowSchema = z.object({
  id: z.string(),
  receivedAt: z.string(),
  service: z.string(),
  kind: itemKindSchema,
  level: levelSchema.nullable(),
  title: z.string(),
  location: z.string(),
  issueId: z.string().nullable(),
});

export const issueRowSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  services: z.string(),
  level: levelSchema,
  title: z.string(),
  culprit: z.string().nullable(),
  count: z.number(),
  firstSeen: z.string(),
  lastSeen: z.string(),
});

export const errorsResultSchema = z.object({
  errors: z.array(errorRowSchema),
  hasMore: z.boolean(),
});

export const issuesResultSchema = z.object({
  issues: z.array(issueRowSchema),
  hasMore: z.boolean(),
});

export const showResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("item"), item: z.custom<Item>(isRecord), markdown: z.string() }),
  z.object({
    type: z.literal("issue"),
    issue: z.custom<IssueDetail>(isRecord),
    markdown: z.string(),
  }),
]);

export const clearResultSchema = z.object({ itemsDeleted: z.number() });

export const statusResultSchema = z.object({
  enabled: z.boolean().nullable(),
  state: z.enum(["running", "stopped", "unavailable", "disabled"]),
  port: z.number().nullable(),
  dbPath: z.string(),
  reason: z.string().nullable(),
  services: z.array(z.string()),
});

export type StatusParams = z.infer<typeof statusParamsSchema>;
export type ErrorsParams = z.infer<typeof errorsParamsSchema>;
export type IssuesParams = z.infer<typeof issuesParamsSchema>;
export type ShowParams = z.infer<typeof showParamsSchema>;
export type ClearParams = z.infer<typeof clearParamsSchema>;
export type ErrorRow = z.infer<typeof errorRowSchema>;
export type IssueRow = z.infer<typeof issueRowSchema>;
export type ErrorsResult = z.infer<typeof errorsResultSchema>;
export type IssuesResult = z.infer<typeof issuesResultSchema>;
export type ShowResult = z.infer<typeof showResultSchema>;
export type ClearResult = z.infer<typeof clearResultSchema>;
export type StatusResult = z.infer<typeof statusResultSchema>;

export const SENTRA_DISABLED_ERROR =
  'sentra_disabled: Sentra is not enabled for this project. Add a "sentra" block to the ZAPS config.';

export const liveItemEventSchema = z.object({ row: errorRowSchema, line: z.string() });
export const liveFailedEventSchema = z.object({ error: z.string() });

export { DEFAULT_LIMIT, MAX_LIMIT, itemKindSchema, levelSchema, sessionIdSchema };
