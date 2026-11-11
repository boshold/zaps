import { z } from "zod";

import { taskPreflightSchema } from "#src/lib/backend/wire.js";

import { CliError } from "./helpers.js";
import type { SessionIpc } from "./helpers.js";
import { writeData } from "./output.js";
import type { OutputFormat } from "./output.js";

interface RunTaskIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  data: (data: unknown, format: OutputFormat) => void;
}

const serviceEventSchema = z.object({
  name: z.string(),
  phase: z.enum(["starting", "waiting", "ready"]),
});

const runResultSchema = z.object({ success: z.boolean() });

const defaultIo: RunTaskIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  data: writeData,
};

/** `--start` → true, `--no-start` → false, neither → undefined (follow config). */
function resolveStartFlag(flags: { start?: boolean; noStart?: boolean }): boolean | undefined {
  if (flags.start && flags.noStart) {
    throw new CliError("Error: --start and --no-start cannot be used together.");
  }
  if (flags.start) {
    return true;
  }
  return flags.noStart ? false : undefined;
}

/** Prints each service/phase line once; heartbeats repeat events and are dropped. */
function createServiceProgressPrinter(write: (text: string) => void): (data: unknown) => void {
  const seen = new Set<string>();
  return (data) => {
    const parsed = serviceEventSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }
    const { name, phase } = parsed.data;
    const id = `${name}\0${phase}`;
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    const line = {
      starting: `Starting ${name}…`,
      waiting: `Waiting for ${name}…`,
      ready: `${name} ready`,
    }[phase];
    write(`${line}\n`);
  };
}

async function notRunningServices(ipc: Pick<SessionIpc, "request">, key: string) {
  try {
    const res = await ipc.request("tasks.preflight", { key });
    const parsed = taskPreflightSchema.safeParse(res.result);
    if (parsed.success) {
      return parsed.data.services.filter((s) => s.action === "start").map((s) => s.name);
    }
  } catch {
    /* Hint is best-effort. */
  }
  return [];
}

function startHint(names: readonly string[]): string {
  const target = names.length > 0 ? names.join(" ") : "<services>";
  return `Start them with "zaps start ${target}" or rerun with --start.`;
}

/** Run a task over IPC; returns the process exit code. */
async function runTask(
  ipc: Pick<SessionIpc, "request" | "stream">,
  options: { key: string; start?: boolean; format: OutputFormat },
  io: RunTaskIo = defaultIo,
): Promise<number> {
  const { key, start, format } = options;
  const printProgress = createServiceProgressPrinter(io.stderr);
  const res = await ipc.stream(
    "tasks.run",
    start === undefined ? { key } : { key, start },
    (event, data) => {
      if (event === "service") {
        printProgress(data);
      } else if (format === "text" && event === "line" && typeof data === "string") {
        io.stdout(`${data}\n`);
      }
    },
  );
  if (res.error !== undefined) {
    io.stderr(`Error: ${res.error}\n`);
    if (res.errorCode === "services_not_running") {
      io.stderr(`${startHint(await notRunningServices(ipc, key))}\n`);
    }
    return 1;
  }
  if (format !== "text") {
    io.data(res.result, format);
    return 0;
  }
  if (!runResultSchema.parse(res.result).success) {
    io.stderr("Task failed.\n");
    return 1;
  }
  return 0;
}

export { createServiceProgressPrinter, resolveStartFlag, runTask };
export type { RunTaskIo };
