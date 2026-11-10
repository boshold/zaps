import { z } from "zod";

const wrapperIdentitySchema = z.object({
  service: z.string().min(1),
  executionId: z.uuid().optional(),
});
const wrapperStartedSchema = wrapperIdentitySchema.extend({
  pid: z.number().int().positive(),
  memberPid: z.number().int().positive().optional(),
});
const wrapperExitSchema = wrapperIdentitySchema.extend({
  code: z.number().int(),
  signal: z.string().nullable().optional(),
  spawnError: z.string().optional(),
});
const execInfoSchema = z.object({
  trackOwnership: z.boolean().optional(),
  command: z.string(),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
});
type ExecInfo = z.infer<typeof execInfoSchema>;
type WrapperExit = z.infer<typeof wrapperExitSchema>;

export { wrapperIdentitySchema, wrapperStartedSchema, wrapperExitSchema, execInfoSchema };
export type { ExecInfo, WrapperExit };
