import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ProcessAuthority, ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import { acquireTmuxOutput } from "#src/lib/backend/tmux/output.js";
import type { OutputLease } from "#src/lib/backend/tmux/output.js";
import type {
  ExecutionEvent,
  ExecutionHandle,
  ExecutionSpec,
  RuntimeDriver,
} from "#src/lib/backend/types.js";
import { shellEscape } from "#src/lib/service/env.js";
import type { TmuxHandle } from "#src/lib/tmux.js";

const wrapperIdentitySchema = z.object({
  service: z.string().min(1),
  executionId: z.uuid().optional(),
});
const wrapperExitSchema = wrapperIdentitySchema.extend({
  code: z.number().int(),
  signal: z.string().nullable().optional(),
  spawnError: z.string().optional(),
});
const execInfoSchema = z.object({
  command: z.string(),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
});
type ExecInfo = z.infer<typeof execInfoSchema>;
type WrapperExit = z.infer<typeof wrapperExitSchema>;
interface Registration {
  handle: ExecutionHandle;
  service: string;
  legacy: boolean;
  info?: ExecInfo;
  exited: (exit: WrapperExit) => void;
}

class WrapperRegistry {
  private readonly records = new Map<string, Registration>();
  private readonly current = new Map<string, string>();

  public register(
    handle: ExecutionHandle,
    service: string,
    info: ExecInfo,
    exited: Registration["exited"],
    legacy = false,
  ): void {
    const parsed = execInfoSchema.parse(info);
    const previous = this.current.get(service);
    if (previous) {
      this.records.delete(previous);
    }
    this.current.set(service, handle.id);
    this.records.set(handle.id, {
      handle,
      service,
      info: parsed,
      exited,
      legacy,
    });
  }

  public registerLegacy(service: string, info: ExecInfo, exited: Registration["exited"]): void {
    this.register(
      { id: randomUUID(), unitId: service, generation: 0 },
      service,
      info,
      exited,
      true,
    );
  }

  private find(identity: z.infer<typeof wrapperIdentitySchema>): Registration | undefined {
    const id = identity.executionId ?? this.current.get(identity.service);
    const record = id ? this.records.get(id) : undefined;
    return record?.service === identity.service &&
      (identity.executionId !== undefined || record.legacy)
      ? record
      : undefined;
  }

  public resolve(identity: z.infer<typeof wrapperIdentitySchema>): ExecInfo | undefined {
    const record = this.find(identity);
    const info = record?.info;
    if (record) {
      delete record.info;
    }
    return info;
  }

  public exited(exit: WrapperExit): void {
    const record = this.find(exit);
    if (!record) {
      return;
    }
    this.remove(record.handle);
    record.exited(exit);
  }

  public remove(handle: ExecutionHandle): void {
    const record = this.records.get(handle.id);
    this.records.delete(handle.id);
    if (record && this.current.get(record.service) === handle.id) {
      this.current.delete(record.service);
    }
  }
}

const sessionRegistries = new WeakMap<object, WrapperRegistry>();
function serviceWrappers(session: object): WrapperRegistry {
  let registry = sessionRegistries.get(session);
  if (!registry) {
    registry = new WrapperRegistry();
    sessionRegistries.set(session, registry);
  }
  return registry;
}

function serviceWrapperCommand(
  command: string,
  sessionId: string,
  service: string,
  executionId: string,
): string {
  return `${command} -s ${shellEscape(sessionId)} exec-service ${shellEscape(service)} --execution-id ${shellEscape(executionId)}`;
}

interface TmuxRuntimeOptions {
  tmux: TmuxHandle;
  sessionId: string;
  zapsCommand: string;
  paneFor: (unitId: string) => string;
  processes: ProcessRunner;
  authority?: ProcessAuthority;
  wrappers: WrapperRegistry;
  getDescendantPids?: (pid: number) => Promise<number[]>;
}
interface PaneExecution {
  handle: ExecutionHandle;
  pane: string;
  output?: OutputLease;
  unsubscribeOutput?: () => void;
  raw: boolean;
  stop?: Promise<void>;
  stopping?: boolean;
  wrapperExit?: WrapperExit;
}

class TmuxRuntime implements RuntimeDriver {
  private readonly records = new Map<string, PaneExecution>();
  private readonly current = new Map<string, string>();
  private readonly listeners = new Set<(event: ExecutionEvent) => void>();

  private readonly options: TmuxRuntimeOptions;
  private readonly getDescendantPids: (pid: number) => Promise<number[]>;

  public constructor(options: TmuxRuntimeOptions) {
    this.options = options;
    this.getDescendantPids =
      options.getDescendantPids ??
      (async (pid) => {
        const { createProcessInspection } =
          await import("#src/lib/backend/runtime/process-inspection.js");
        return createProcessInspection().getDescendantPids(pid);
      });
  }

  public async start(spec: ExecutionSpec): Promise<ExecutionHandle> {
    if (spec.placement === "background") {
      return this.options.processes.spawnOwned({ ...spec, authority: this.options.authority });
    }
    if (this.current.has(spec.unitId)) {
      throw new Error(`Execution still owned: ${spec.unitId}`);
    }
    const handle = Object.freeze({
      id: randomUUID(),
      unitId: spec.unitId,
      generation: spec.generation,
    });
    const pane = this.options.paneFor(spec.unitId);
    const record: PaneExecution = { handle, pane, raw: spec.raw };
    this.records.set(handle.id, record);
    this.current.set(handle.unitId, handle.id);
    if (!spec.raw) {
      this.options.wrappers.register(
        handle,
        spec.unitId,
        { command: spec.command, cwd: spec.cwd, env: { ...spec.env } },
        (exit) => {
          record.wrapperExit = exit;
          if (!record.stopping) {
            this.release(record, exit);
          }
        },
      );
    }
    try {
      const command = spec.raw
        ? `cd ${shellEscape(spec.cwd)} && env -i ${Object.entries(spec.env)
            .map(([key, value]) => shellEscape(`${key}=${value}`))
            .join(" ")} sh -c ${shellEscape(spec.command)}`
        : serviceWrapperCommand(
            this.options.zapsCommand,
            this.options.sessionId,
            spec.unitId,
            handle.id,
          );
      await this.options.tmux.sendKeys(pane, command);
      record.output = acquireTmuxOutput(this.options.tmux.capturePane, pane, 250);
      record.output.producer.reset();
      record.unsubscribeOutput = record.output.producer.subscribe((lines) => {
        if (this.lookup(handle) === record) {
          this.publish({
            kind: "output",
            unitId: handle.unitId,
            generation: handle.generation,
            lines,
          });
        }
      });
    } catch (error) {
      this.records.delete(handle.id);
      this.options.wrappers.remove(handle);
      if (this.current.get(handle.unitId) === handle.id) {
        this.current.delete(handle.unitId);
      }
      throw error;
    }
    return handle;
  }

  private lookup(handle: ExecutionHandle): PaneExecution | undefined {
    const record = this.records.get(handle.id);
    return record?.handle.unitId === handle.unitId &&
      record.handle.generation === handle.generation &&
      this.current.get(handle.unitId) === handle.id
      ? record
      : undefined;
  }

  private release(record: PaneExecution, exit?: WrapperExit): void {
    const { handle } = record;
    if (this.lookup(handle) !== record) {
      return;
    }
    record.unsubscribeOutput?.();
    record.output?.release();
    this.records.delete(handle.id);
    if (this.current.get(handle.unitId) === handle.id) {
      this.current.delete(handle.unitId);
    }
    this.options.wrappers.remove(handle);
    let signal = exit?.signal ?? null;
    if (!exit && record.stopping) {
      signal = "SIGINT";
    }
    for (const kind of ["leaderExit", "exit"] as const) {
      this.publish({
        kind,
        unitId: handle.unitId,
        generation: handle.generation,
        code: exit?.code ?? null,
        signal,
        ...(exit?.spawnError === undefined ? {} : { spawnError: exit.spawnError }),
      });
    }
  }

  // oxlint-disable-next-line promise-function-async
  public stop(handle: ExecutionHandle): Promise<void> {
    const record = this.lookup(handle);
    if (!record) {
      return this.options.processes.stop(handle);
    }
    record.stopping = true;
    record.stop ??= this.stopPane(record);
    return record.stop;
  }

  private static async bounded<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("termination deadline exceeded");
    }
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("termination deadline exceeded")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async stopPane(record: PaneExecution): Promise<void> {
    const deadline = Date.now() + 5000;
    try {
      await TmuxRuntime.bounded(async () => this.options.tmux.sendCtrlC(record.pane), deadline);
      while (this.lookup(record.handle) === record) {
        const running = await TmuxRuntime.bounded(
          async () => this.paneHasCommand(record),
          deadline,
        );
        if (!running) {
          this.release(record, record.wrapperExit);
          return;
        }
        await TmuxRuntime.bounded(
          async () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
          deadline,
        );
      }
    } catch (error) {
      record.stop = undefined;
      throw new Error(`Tmux cleanup incomplete for ${record.handle.unitId}: ${String(error)}`, {
        cause: error,
      });
    }
  }

  private async paneHasCommand(record: PaneExecution): Promise<boolean> {
    if (
      !(await this.options.tmux.paneExists(record.pane)) ||
      (await this.options.tmux.displayMessage(record.pane, "#{pane_dead}")) === "1"
    ) {
      return false;
    }
    const root = await this.options.tmux.panePid(record.pane);
    const descendants = await this.getDescendantPids(root);
    return descendants.some((pid) => pid !== root);
  }

  public async isRunning(handle: ExecutionHandle): Promise<boolean> {
    const record = this.lookup(handle);
    if (!record) {
      return this.options.processes.isRunning(handle);
    }
    if (
      !(await this.options.tmux.paneExists(record.pane)) ||
      (await this.options.tmux.displayMessage(record.pane, "#{pane_dead}")) === "1"
    ) {
      return false;
    }
    if (record.raw) {
      return this.paneHasCommand(record);
    }
    return true;
  }

  public async getPid(handle: ExecutionHandle): Promise<number | undefined> {
    const record = this.lookup(handle);
    const pid = record
      ? await this.options.tmux.panePid(record.pane)
      : this.options.processes.getPid(handle);
    return pid > 0 ? pid : undefined;
  }

  public async readOutput(handle: ExecutionHandle, tail: number): Promise<string[]> {
    const record = this.lookup(handle);
    if (!record) {
      return this.options.processes.readOutput(handle, tail);
    }
    return record.output?.producer.read(tail) ?? [];
  }

  private publish(event: ExecutionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  public subscribe(listener: (event: ExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    const unsubscribe = this.options.processes.subscribe(listener);
    return () => {
      this.listeners.delete(listener);
      unsubscribe();
    };
  }
}

export {
  TmuxRuntime,
  WrapperRegistry,
  serviceWrappers,
  serviceWrapperCommand,
  wrapperIdentitySchema,
  wrapperExitSchema,
  execInfoSchema,
};
