import { randomUUID } from "node:crypto";

import type { z } from "zod";

import { SessionClosingError } from "#src/lib/backend/admission-error.js";
import type { ProcessAuthority, ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import { TmuxOutputProducer } from "#src/lib/backend/tmux/output.js";
import { PaneCleanup, bounded } from "#src/lib/backend/tmux/pane-cleanup.js";
import type { PaneCleanupOptions, PaneOwnership } from "#src/lib/backend/tmux/pane-cleanup.js";
import { createRawPaneLaunch } from "#src/lib/backend/tmux/raw-launch.js";
import type { RawPaneLaunch } from "#src/lib/backend/tmux/raw-launch.js";
import {
  execInfoSchema,
  wrapperExitSchema,
  wrapperIdentitySchema,
} from "#src/lib/backend/tmux/wrapper-schema.js";
import type { ExecInfo, WrapperExit } from "#src/lib/backend/tmux/wrapper-schema.js";
import type {
  ExecutionEvent,
  ExecutionHandle,
  ExecutionSpec,
  RuntimeDriver,
} from "#src/lib/backend/types.js";
import { shellEscape } from "#src/lib/service/env.js";
import type { TmuxHandle } from "#src/lib/tmux.js";

interface Registration {
  handle: ExecutionHandle;
  service: string;
  legacy: boolean;
  info?: ExecInfo;
  exited: (exit: WrapperExit) => void | Promise<void>;
  started?: (pid: number, memberPid?: number) => Promise<void>;
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
    started?: (pid: number, memberPid?: number) => Promise<void>,
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
      started,
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

  public async started(
    identity: z.infer<typeof wrapperIdentitySchema>,
    pid: number,
    memberPid?: number,
  ): Promise<void> {
    const record = this.find(identity);
    if (!record?.started) {
      throw new Error("No owned wrapper launch");
    }
    await record.started(pid, memberPid);
    if (this.find(identity) !== record) {
      throw new Error("Stale wrapper launch");
    }
  }

  public tracks(identity: z.infer<typeof wrapperIdentitySchema>): boolean {
    return Boolean(this.find(identity)?.started);
  }

  public async exited(exit: WrapperExit): Promise<void> {
    const record = this.find(exit);
    if (!record) {
      return;
    }
    this.remove(record.handle);
    await record.exited(exit);
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
function bindServiceWrappers(session: object, registry: WrapperRegistry): void {
  sessionRegistries.set(session, registry);
}
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

interface TmuxRuntimeOptions extends PaneCleanupOptions {
  rawLaunch?: (command: string, active: () => void, shell: string) => RawPaneLaunch;
  tmux: TmuxHandle;
  environmentFile?: (env: Record<string, string>) => string;
  removeEnvironmentFile?: (file: string) => void;
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
  output?: TmuxOutputProducer;
  unsubscribeOutput?: () => void;
  raw: boolean;
  rawLaunch?: RawPaneLaunch;
  rawHolder?: number;
  environmentFile?: string;
  ownership: Promise<PaneOwnership>;
  stop?: Promise<void>;
  stopping?: boolean;
  wrapperExit?: WrapperExit;
  leaderReported?: boolean;
  finalReported?: boolean;
}

class TmuxRuntime implements RuntimeDriver {
  private admissionClosed = false;
  private readonly records = new Map<string, PaneExecution>();
  private readonly current = new Map<string, string>();
  private readonly paneBaselines = new Map<string, string[]>();
  private readonly listeners = new Set<(event: ExecutionEvent) => void>();

  private readonly options: TmuxRuntimeOptions;
  private readonly getDescendantPids: (pid: number) => Promise<number[]>;
  private readonly cleanup: PaneCleanup;

  public constructor(options: TmuxRuntimeOptions) {
    this.options = options;
    this.getDescendantPids =
      options.getDescendantPids ??
      (async (pid) => {
        const { createProcessInspection } =
          await import("#src/lib/backend/runtime/process-inspection.js");
        return createProcessInspection().getDescendantPids(pid);
      });
    this.cleanup = new PaneCleanup(this.getDescendantPids, options);
  }

  public closeAdmission(): void {
    this.admissionClosed = true;
    this.options.processes.closeAdmission();
  }

  private assertAdmission(): void {
    if (this.admissionClosed) {
      throw new SessionClosingError();
    }
  }

  public async start(spec: ExecutionSpec): Promise<ExecutionHandle> {
    this.assertAdmission();
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
    const record: PaneExecution = {
      handle,
      pane,
      raw: spec.raw,
      ownership: this.cleanup.capture(this.options.tmux.panePid(pane)),
    };
    this.records.set(handle.id, record);
    this.current.set(handle.unitId, handle.id);
    if (!spec.raw) {
      this.options.wrappers.register(
        handle,
        spec.unitId,
        { command: spec.command, cwd: spec.cwd, env: { ...spec.env } },
        async (exit) => {
          record.wrapperExit = exit;
          this.publishLeader(record, exit);
          if (!record.stopping) {
            await this.finishExited(record);
          }
        },
        false,
        async (pid, memberPid) => {
          this.assertAdmission();
          if (record.stopping || this.lookup(handle) !== record) {
            throw new Error("Wrapper launch cancelled");
          }
          await this.cleanup.register(record.ownership, pid, memberPid);
          this.assertAdmission();
          if (record.stopping || this.lookup(handle) !== record) {
            throw new Error("Wrapper launch cancelled");
          }
        },
      );
    }
    record.output = new TmuxOutputProducer(
      this.options.tmux.capturePane,
      pane,
      250,
      this.paneBaselines.get(pane) ?? [],
    );
    record.unsubscribeOutput = record.output.subscribe((lines) => {
      if (this.lookup(handle) === record) {
        this.publish({
          kind: "output",
          unitId: handle.unitId,
          generation: handle.generation,
          lines,
        });
      }
    });
    let envFile: string | undefined = undefined;
    let dispatched = false;
    try {
      envFile = spec.raw ? this.options.environmentFile?.({ ...spec.env }) : undefined;
      record.environmentFile = envFile;
      let command = serviceWrapperCommand(
        this.options.zapsCommand,
        this.options.sessionId,
        spec.unitId,
        handle.id,
      );
      if (spec.raw) {
        const shell = spec.env.PATH === undefined ? "/bin/sh" : "sh";
        record.rawLaunch = (this.options.rawLaunch ?? createRawPaneLaunch)(
          spec.command,
          () => {
            this.assertAdmission();
            if (record.stopping || this.lookup(handle) !== record) {
              throw new Error("Raw launch cancelled");
            }
          },
          shell,
        );
        const rawFile = record.rawLaunch.file;
        command = envFile
          ? `cd ${shellEscape(spec.cwd)} && env -i sh -c ${shellEscape('. "$1"; rm -f "$1"; shift; exec "$@"')} sh ${shellEscape(envFile)} ${shellEscape(shell)} ${shellEscape(rawFile)}`
          : `cd ${shellEscape(spec.cwd)} && env -i ${Object.entries(spec.env)
              .map(([key, value]) => shellEscape(`${key}=${value}`))
              .join(" ")} ${shellEscape(shell)} ${shellEscape(rawFile)}`;
      }
      await record.ownership;
      this.assertAdmission();
      dispatched = true;
      await this.options.tmux.sendKeys(pane, command);
      await this.activateRaw(record);
    } catch (error) {
      await this.finishFailedRawLaunch(record, dispatched, error);
      if (this.lookup(handle) === record && record.output) {
        this.paneBaselines.set(record.pane, record.output.snapshot());
      }
      record.unsubscribeOutput?.();
      record.output?.stop();
      if (envFile) {
        this.options.removeEnvironmentFile?.(envFile);
      }
      this.records.delete(handle.id);
      this.options.wrappers.remove(handle);
      if (this.current.get(handle.unitId) === handle.id) {
        this.current.delete(handle.unitId);
      }
      throw error;
    }
    return handle;
  }

  private async activateRaw(record: PaneExecution): Promise<void> {
    const launch = record.rawLaunch;
    if (!launch) {
      return;
    }
    const pid = await launch.holder();
    await this.cleanup.registerPaneCommand(record.ownership, pid, async () => launch.confirm());
    record.rawHolder = pid;
    await launch.start();
  }

  private async finishFailedRawLaunch(
    record: PaneExecution,
    dispatched: boolean,
    error: unknown,
  ): Promise<void> {
    const launch = record.rawLaunch;
    if (launch && !launch.started) {
      launch.dispose();
      return;
    }
    if (launch && dispatched) {
      try {
        await this.stop(record.handle);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Raw launch cleanup incomplete", {
          cause: cleanupError,
        });
      }
    }
    launch?.dispose();
  }

  public retainPanes(panes: ReadonlySet<string>): void {
    for (const pane of this.paneBaselines.keys()) {
      if (!panes.has(pane)) {
        this.paneBaselines.delete(pane);
      }
    }
  }

  public async dispose(): Promise<void> {
    this.closeAdmission();
    const results = await Promise.allSettled([
      ...[...this.records.values()].map(async (record) => this.stop(record.handle)),
      this.options.processes.dispose(),
    ]);
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length) {
      throw new AggregateError(failures, "Runtime cleanup incomplete");
    }
    this.paneBaselines.clear();
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
    if (record.environmentFile) {
      this.options.removeEnvironmentFile?.(record.environmentFile);
    }
    if (record.output) {
      this.paneBaselines.set(record.pane, record.output.snapshot());
    }
    record.unsubscribeOutput?.();
    record.output?.stop();
    record.rawLaunch?.dispose();
    this.records.delete(handle.id);
    if (this.current.get(handle.unitId) === handle.id) {
      this.current.delete(handle.unitId);
    }
    this.options.wrappers.remove(handle);
    this.publishLeader(record, exit);
    this.publishFinal(record);
  }

  private publishLeader(record: PaneExecution, exit?: WrapperExit): void {
    if (record.leaderReported) {
      return;
    }
    record.leaderReported = true;
    this.publish({
      kind: "leaderExit",
      unitId: record.handle.unitId,
      generation: record.handle.generation,
      code: exit?.code ?? null,
      signal: exit === undefined && record.stopping ? "SIGINT" : (exit?.signal ?? null),
      ...(exit?.spawnError === undefined ? {} : { spawnError: exit.spawnError }),
    });
  }

  private publishFinal(record: PaneExecution, cleanupError?: string): void {
    if (record.finalReported) {
      return;
    }
    record.finalReported = true;
    const exit = record.wrapperExit;
    this.publish({
      kind: "exit",
      unitId: record.handle.unitId,
      generation: record.handle.generation,
      code: exit?.code ?? null,
      signal: exit === undefined && record.stopping ? "SIGINT" : (exit?.signal ?? null),
      ...(exit?.spawnError === undefined ? {} : { spawnError: exit.spawnError }),
      ...(cleanupError === undefined ? {} : { cleanupError }),
    });
  }

  private async finishExited(record: PaneExecution): Promise<void> {
    try {
      await this.stop(record.handle);
    } catch {
      // StopPane reports failure while retaining ownership.
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

  private async stopPane(record: PaneExecution): Promise<void> {
    try {
      const deadline = await this.cleanup.stop(
        record.ownership,
        async () => {
          /* Unverified foreground receives no terminal input. */
        },
        async () => this.paneHasCommand(record),
        () => record.rawLaunch?.release(),
      );
      if (record.output) {
        const drainDeadline = Math.min(Date.now() + 1000, deadline);
        await bounded(async () => record.output?.drain(), drainDeadline);
        await bounded(async () => record.output?.poll(), drainDeadline);
      }
      this.release(record, record.wrapperExit);
    } catch (error) {
      record.stop = undefined;
      this.publishFinal(record, String(error));
      throw new Error(`Tmux cleanup incomplete for ${record.handle.unitId}: ${String(error)}`, {
        cause: error,
      });
    }
  }

  private async paneHasCommand(record: PaneExecution): Promise<boolean> {
    if (record.rawHolder !== undefined) {
      return this.cleanup.workload(record.ownership, record.rawHolder);
    }
    if (
      !(await this.options.tmux.paneExists(record.pane)) ||
      (await this.options.tmux.displayMessage(record.pane, "#{pane_dead}")) === "1"
    ) {
      return false;
    }
    const root = await this.options.tmux.panePid(record.pane);
    const descendants = await this.cleanup.candidates(
      record.ownership,
      await this.getDescendantPids(root),
    );
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
    return record.output?.read(tail) ?? [];
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
  bindServiceWrappers,
  serviceWrapperCommand,
  wrapperIdentitySchema,
  wrapperExitSchema,
  execInfoSchema,
};
