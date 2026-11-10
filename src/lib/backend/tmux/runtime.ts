import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ProcessAuthority, ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import type {
  ExecutionEvent,
  ExecutionHandle,
  ExecutionSpec,
  RuntimeDriver,
} from "#src/lib/backend/types.js";
import { getDescendantPids } from "#src/lib/port.js";
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
}
interface PaneExecution {
  handle: ExecutionHandle;
  pane: string;
  output: string[];
  raw: boolean;
}

class TmuxRuntime implements RuntimeDriver {
  private readonly records = new Map<string, PaneExecution>();
  private readonly current = new Map<string, string>();
  private readonly listeners = new Set<(event: ExecutionEvent) => void>();

  private readonly options: TmuxRuntimeOptions;
  private captureTimer?: ReturnType<typeof setTimeout>;

  public constructor(options: TmuxRuntimeOptions) {
    this.options = options;
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
    const record: PaneExecution = { handle, pane, output: [], raw: spec.raw };
    this.records.set(handle.id, record);
    this.current.set(handle.unitId, handle.id);
    if (!spec.raw) {
      this.options.wrappers.register(
        handle,
        spec.unitId,
        { command: spec.command, cwd: spec.cwd, env: { ...spec.env } },
        (exit) => {
          if (this.lookup(handle)) {
            this.records.delete(handle.id);
            this.current.delete(handle.unitId);
            for (const kind of ["leaderExit", "exit"] as const) {
              this.publish({
                code: exit.code,
                ...(exit.spawnError === undefined ? {} : { spawnError: exit.spawnError }),
                kind,
                unitId: handle.unitId,
                generation: handle.generation,
                signal: exit.signal ?? null,
              });
            }
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
      this.scheduleCapture();
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

  public async stop(handle: ExecutionHandle): Promise<void> {
    const record = this.lookup(handle);
    if (!record) {
      await this.options.processes.stop(handle);
      return;
    }
    await this.options.tmux.sendCtrlC(record.pane);
    this.records.delete(handle.id);
    this.current.delete(handle.unitId);
    this.options.wrappers.remove(handle);
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
      const pid = await this.options.tmux.panePid(record.pane);
      const descendants = await getDescendantPids(pid);
      return descendants.length > 0;
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
    const output = tail > 0 ? await this.options.tmux.capturePane(record.pane, tail) : "";
    return tail > 0 ? output.split("\n").slice(-tail) : [];
  }

  private scheduleCapture(): void {
    if (this.captureTimer || !this.listeners.size || !this.records.size) {
      return;
    }
    this.captureTimer = setTimeout(() => {
      this.captureTimer = undefined;
      void this.captureOutput();
    }, 250);
    this.captureTimer.unref();
  }

  private async captureOutput(): Promise<void> {
    for (const record of this.records.values()) {
      if (!this.lookup(record.handle)) {
        continue;
      }
      try {
        const captured = await this.options.tmux.capturePane(record.pane, 500);
        if (!this.lookup(record.handle)) {
          continue;
        }
        const lines = captured.split("\n");
        let overlap = Math.min(record.output.length, lines.length);
        while (
          overlap > 0 &&
          !record.output.slice(-overlap).every((line, index) => line === lines[index])
        ) {
          overlap -= 1;
        }
        const added = lines.slice(overlap);
        record.output = lines;
        if (added.length) {
          this.publish({
            kind: "output",
            unitId: record.handle.unitId,
            generation: record.handle.generation,
            lines: added,
          });
        }
      } catch {
        // A pane may disappear during capture.
      }
    }
    this.scheduleCapture();
  }

  private publish(event: ExecutionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  public subscribe(listener: (event: ExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    this.scheduleCapture();
    const unsubscribe = this.options.processes.subscribe(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearTimeout(this.captureTimer);
        this.captureTimer = undefined;
      }
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
