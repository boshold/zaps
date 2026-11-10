import { randomUUID } from "node:crypto";

import { createProcessInspection } from "#src/lib/backend/runtime/process-inspection.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import { acquireTmuxOutput } from "#src/lib/backend/tmux/output.js";
import type { OutputLease } from "#src/lib/backend/tmux/output.js";
import { PaneCleanup, bounded } from "#src/lib/backend/tmux/pane-cleanup.js";
import type { PaneCleanupOptions, PaneOwnership } from "#src/lib/backend/tmux/pane-cleanup.js";
import { serviceWrapperCommand } from "#src/lib/backend/tmux/runtime.js";
import type {
  ExecutionEvent,
  ExecutionHandle,
  ExecutionSpec,
  RuntimeDriver,
} from "#src/lib/backend/types.js";
import { formatEnvForShell, shellEscape } from "#src/lib/service/env.js";
import type { ServiceManagerDeps } from "#src/lib/service/manager.js";

const wrapperExits = new WeakMap<
  object,
  Map<string, (details: { code: number; signal: string | null; spawnError?: string }) => void>
>();

type LegacyDeps = Omit<ServiceManagerDeps, "runtime" | "inspectPorts">;
interface RuntimeRecord {
  handle: ExecutionHandle;
  background: boolean;
  target?: string;
  output?: OutputLease;
  unsubscribe?: () => void;
  ownership?: Promise<PaneOwnership>;
  stop?: Promise<void>;
  stopping?: boolean;
  finalReported?: boolean;
  exit?: { code: number; signal: string | null; spawnError?: string };
}

// Removed when session composition installs SessionBackend (P02-T08).
class ServiceRuntime implements RuntimeDriver {
  private readonly records = new Map<string, RuntimeRecord>();
  private readonly listeners = new Set<(event: ExecutionEvent) => void>();
  private readonly runner: ProcessRunner;
  private readonly deps: LegacyDeps;
  private readonly targets: Readonly<Record<string, string>>;
  private readonly cleanup: PaneCleanup;
  public constructor(
    deps: LegacyDeps,
    targets: Readonly<Record<string, string>>,
    options: PaneCleanupOptions,
  ) {
    this.deps = deps;
    this.targets = targets;
    this.cleanup = new PaneCleanup(async (pid) => deps.getDescendantPids(pid), options);
    this.runner = new ProcessRunner({
      onLines: () => {
        /* Runtime events carry generation identity. */
      },
      onExit: () => {
        /* Runtime events include final cleanup details. */
      },
      record: async (pid) => deps.recordDetached?.(pid),
      unrecord: async (pid) => deps.removeDetached?.(pid),
      spawn: deps.detachedSpawn,
    });
    this.runner.subscribe((event) => this.publish(event));
  }
  private publish(event: ExecutionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
  public async start(spec: ExecutionSpec): Promise<ExecutionHandle> {
    const previous = this.records.get(spec.unitId);
    previous?.unsubscribe?.();
    previous?.output?.release();
    if (spec.placement === "background") {
      const handle = this.runner.spawnOwned({ ...spec, env: { ...spec.env } });
      this.records.set(spec.unitId, { handle, background: true });
      return handle;
    }
    const handle = { id: randomUUID(), unitId: spec.unitId, generation: spec.generation };
    const record: RuntimeRecord = { handle, background: false };
    this.records.set(spec.unitId, record);
    const target = this.targets[spec.unitId];
    if (!target) {
      throw new Error(`Unknown service: ${spec.unitId}`);
    }
    record.target = target;
    record.ownership = this.cleanup.capture(this.deps.panePid(target));
    record.output = acquireTmuxOutput(this.deps.capturePane, target);
    record.output.producer.reset();
    await record.output.producer.poll();
    record.unsubscribe = record.output.producer.subscribe((lines) =>
      this.publish({ kind: "output", unitId: spec.unitId, generation: spec.generation, lines }),
    );
    if (spec.raw) {
      const env = { ...spec.env };
      const envFile = this.deps.environmentFile?.(env);
      const prefix = formatEnvForShell(env);
      const command = envFile
        ? `cd ${JSON.stringify(spec.cwd)} && env -i sh -c ${shellEscape('. "$1"; rm -f "$1"; shift; exec "$@"')} sh ${shellEscape(envFile)} sh -c ${shellEscape(spec.command)}`
        : `cd ${JSON.stringify(spec.cwd)} && ${prefix ? `${prefix} ` : ""}${spec.command}`;
      try {
        await this.deps.sendKeys(target, command);
      } catch (error) {
        if (envFile) {
          this.deps.removeEnvironmentFile?.(envFile);
        }
        throw error;
      }
    } else {
      let exits = wrapperExits.get(this.deps);
      if (!exits) {
        exits = new Map();
        wrapperExits.set(this.deps, exits);
      }
      exits.set(handle.id, (details) => {
        exits.delete(handle.id);
        if (this.lookup(handle) !== record) {
          return;
        }
        if (record.exit) {
          return;
        }
        record.exit = details;
        this.publish({
          kind: "leaderExit",
          unitId: handle.unitId,
          generation: handle.generation,
          ...details,
        });
        if (!record.stopping) {
          void this.finishExited(record);
        }
      });
      this.deps.storeExecInfo(
        spec.unitId,
        { command: spec.command, cwd: spec.cwd, env: { ...spec.env } },
        handle.id,
        spec.generation,
      );
      await this.deps.sendKeys(
        target,
        serviceWrapperCommand(this.deps.zapsCommand, this.deps.sessionId, spec.unitId, handle.id),
      );
    }
    return handle;
  }
  private lookup(handle: ExecutionHandle): RuntimeRecord | undefined {
    const record = this.records.get(handle.unitId);
    return record?.handle.id === handle.id && record.handle.generation === handle.generation
      ? record
      : undefined;
  }
  public async stop(handle: ExecutionHandle): Promise<void> {
    const record = this.lookup(handle);
    if (!record) {
      return;
    }
    record.stopping = true;
    record.stop ??= this.stopRecord(record);
    try {
      await record.stop;
    } catch (error) {
      record.stop = undefined;
      if (!record.background) {
        this.reportExit(record, String(error));
      }
      throw error;
    }
  }
  private async finishExited(record: RuntimeRecord): Promise<void> {
    try {
      await this.stop(record.handle);
    } catch {
      // Stop reports failure while retaining ownership.
    }
  }
  private reportExit(record: RuntimeRecord, cleanupError?: string): void {
    if (record.finalReported) {
      return;
    }
    record.finalReported = true;
    this.publish({
      kind: "exit",
      unitId: record.handle.unitId,
      generation: record.handle.generation,
      code: record.exit?.code ?? null,
      signal: record.exit?.signal ?? "SIGINT",
      ...(record.exit?.spawnError === undefined ? {} : { spawnError: record.exit.spawnError }),
      ...(cleanupError === undefined ? {} : { cleanupError }),
    });
  }
  private async stopRecord(record: RuntimeRecord): Promise<void> {
    const { handle } = record;
    if (record.background) {
      await this.runner.stop(handle);
    } else if (record.target) {
      const { target } = record;
      const ownership = record.ownership ?? this.cleanup.capture(this.deps.panePid(target));
      const deadline = await this.cleanup.stop(
        ownership,
        async () => this.deps.sendCtrlC(target),
        async () => this.isRunning(handle),
      );
      const drainDeadline = Math.min(Date.now() + 1000, deadline);
      await bounded(async () => record.output?.producer.drain(), drainDeadline);
      await bounded(async () => record.output?.producer.poll(), drainDeadline);
    }
    record.unsubscribe?.();
    record.output?.release();
    wrapperExits.get(this.deps)?.delete(handle.id);
    this.records.delete(handle.unitId);
    if (!record.background) {
      this.reportExit(record);
    }
  }

  public async getPid(handle: ExecutionHandle): Promise<number | undefined> {
    const record = this.lookup(handle);
    if (!record) {
      return undefined;
    }
    let pid = -1;
    if (record.background) {
      pid = this.runner.getPid(handle);
    } else if (record.target) {
      pid = await this.deps.panePid(record.target);
    }
    return pid > 0 ? pid : undefined;
  }
  public async isRunning(handle: ExecutionHandle): Promise<boolean> {
    const record = this.lookup(handle);
    if (!record) {
      return false;
    }
    if (record.background) {
      return this.runner.isRunning(handle);
    }
    const pid = await this.getPid(handle);
    if (pid === undefined) {
      return false;
    }
    const descendants = await this.deps.getDescendantPids(pid);
    return descendants.some((child) => child !== pid);
  }
  public async readOutput(handle: ExecutionHandle, tail: number): Promise<string[]> {
    const record = this.lookup(handle);
    return record?.background
      ? this.runner.readOutput(handle, tail)
      : (record?.output?.producer.read(tail) ?? []);
  }
  public subscribe(listener: (event: ExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function withServiceRuntime<T extends LegacyDeps>(
  deps: T,
  options: PaneCleanupOptions = {},
): T & Pick<ServiceManagerDeps, "runtime" | "inspectPorts"> {
  return Object.assign(deps, {
    runtime: (targets: Record<string, string>) => new ServiceRuntime(deps, targets, options),
    inspectPorts: async (pid: number) => createProcessInspection().detectPortsForPid(pid),
  });
}

function serviceRuntimeExited(
  deps: LegacyDeps,
  executionId: string,
  details: { code: number; signal: string | null; spawnError?: string },
): void {
  wrapperExits.get(deps)?.get(executionId)?.(details);
}

export { withServiceRuntime, serviceRuntimeExited };
