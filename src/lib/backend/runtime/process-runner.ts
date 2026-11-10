import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { ExecutionHandle } from "#src/lib/backend/types.js";

import { createProcessInspection, sameProcess } from "./process-inspection.js";
import type { ProcessIdentity } from "./process-inspection.js";

const STOP_GRACE_MS = 5000;
const KILL_WAIT_MS = 1000;
const GATE_COMMAND = 'read -r zaps_gate <&3 || exit 125; exec 3<&-; exec sh -c "$1"';

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
interface ProcessSpawnOptions {
  unitId: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  generation: number;
}
interface ProcessRunnerDeps {
  onLines: (unitId: string, lines: string[]) => void;
  onExit: (unitId: string, generation: number) => void;
  record?: (pid: number) => void | Promise<void>;
  unrecord?: (pid: number) => void | Promise<void>;
  spawn?: SpawnFn;
  admit?: () => boolean;
  readProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
  getProcessMembers?: (identity: ProcessIdentity) => Promise<ProcessIdentity[]>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  diagnostic?: (message: string) => void;
}
interface OwnedProcess {
  handle: ExecutionHandle;
  child: ChildProcess;
  pid: number;
  members: Map<number, ProcessIdentity>;
  identity?: ProcessIdentity;
  ready: Promise<void>;
  stop?: Promise<void>;
  stopping: boolean;
  exited: boolean;
  finalized: boolean;
  unexpected: boolean;
  stdout: string;
  stderr: string;
  lines: string[];
  monitor?: ReturnType<typeof setTimeout>;
}

export class ProcessRunner {
  private readonly records = new Map<string, OwnedProcess>();
  private readonly units = new Map<string, ExecutionHandle>();
  private readonly deps;
  private disposed = false;

  public constructor(deps: ProcessRunnerDeps) {
    const inspection = createProcessInspection();
    this.deps = {
      ...deps,
      readProcessIdentity: deps.readProcessIdentity ?? inspection.readProcessIdentity,
      getProcessMembers: deps.getProcessMembers ?? inspection.getProcessMembers,
      spawn: deps.spawn ?? spawn,
      kill:
        deps.kill ??
        ((pid: number, signal: NodeJS.Signals) => {
          process.kill(pid, signal);
        }),
      now: deps.now ?? Date.now,
      wait: deps.wait ?? (async (ms: number) => delay(ms)),
      diagnostic:
        deps.diagnostic ??
        ((message: string) => {
          process.stderr.write(`${message}\n`);
        }),
    };
  }

  public spawnOwned(opts: ProcessSpawnOptions): ExecutionHandle {
    if (this.disposed || this.deps.admit?.() === false) {
      throw new Error("session_closing");
    }
    if (this.units.has(opts.unitId)) {
      throw new Error(`Execution still owned: ${opts.unitId}`);
    }
    const handle = Object.freeze({
      id: randomUUID(),
      unitId: opts.unitId,
      generation: opts.generation,
    });
    const child = this.deps.spawn("sh", ["-c", GATE_COMMAND, "zaps", opts.command], {
      cwd: opts.cwd,
      env: { ...opts.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const proc: OwnedProcess = {
      handle,
      child,
      pid: child.pid ?? -1,
      members: new Map(),
      ready: Promise.resolve(),
      stopping: false,
      exited: false,
      finalized: false,
      unexpected: false,
      stdout: "",
      stderr: "",
      lines: [],
    };
    this.records.set(handle.id, proc);
    this.units.set(opts.unitId, handle);
    child.stdout?.on("data", (chunk: Buffer) => {
      this.output(proc, "stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.output(proc, "stderr", chunk);
    });
    const exited = () => {
      if (proc.exited) {
        return;
      }
      proc.exited = true;
      proc.unexpected = !proc.stopping;
      clearTimeout(proc.monitor);
      void this.stopObserved(handle);
    };
    child.on("exit", exited);
    child.on("error", exited);
    proc.ready = this.register(proc);
    void this.observeRegistration(proc);
    return handle;
  }

  private async stopObserved(handle: ExecutionHandle): Promise<void> {
    try {
      await this.stop(handle);
    } catch (error) {
      this.deps.diagnostic(`Process cleanup incomplete: ${String(error)}`);
    }
  }

  private async observeRegistration(proc: OwnedProcess): Promise<void> {
    try {
      await proc.ready;
    } catch (error) {
      this.deps.diagnostic(`Process registration failed: ${String(error)}`);
      await this.stopObserved(proc.handle);
    }
  }

  private async observeMembers(proc: OwnedProcess): Promise<void> {
    try {
      await this.refresh(proc);
    } catch (error) {
      this.deps.diagnostic(`Process ownership probe failed: ${String(error)}`);
    } finally {
      this.monitor(proc);
    }
  }

  private async cleanupAttempt(proc: OwnedProcess): Promise<void> {
    try {
      await this.cleanup(proc);
    } catch (error) {
      proc.stop = undefined;
      throw error;
    }
  }

  private static gate(proc: OwnedProcess): Writable | undefined {
    const { 3: stream } = proc.child.stdio;
    return stream instanceof Writable ? stream : undefined;
  }

  private async register(proc: OwnedProcess): Promise<void> {
    if (proc.pid <= 0) {
      return;
    }
    const identity = await ProcessRunner.probe(this.deps.readProcessIdentity(proc.pid));
    if (
      !identity ||
      identity.pid !== proc.pid ||
      identity.pgid !== proc.pid ||
      (typeof identity.sid === "number" && identity.sid !== proc.pid)
    ) {
      ProcessRunner.gate(proc)?.destroy();
      throw new Error(`Missing birth identity for ${proc.pid}`);
    }
    proc.identity = identity;
    proc.members.set(identity.pid, identity);
    await ProcessRunner.probe(Promise.resolve(this.deps.record?.(proc.pid)));
    await this.refresh(proc);
    const gate = ProcessRunner.gate(proc);
    gate?.on("error", () => {
      /* Gate closure is expected during cleanup. */
    });
    if (proc.stopping || proc.exited || this.disposed || this.deps.admit?.() === false) {
      gate?.destroy();
    } else {
      gate?.end("run\n");
      this.monitor(proc);
    }
  }

  private monitor(proc: OwnedProcess): void {
    if (proc.exited || proc.stopping || proc.finalized) {
      return;
    }
    proc.monitor = setTimeout(() => {
      void this.observeMembers(proc);
    }, 25);
  }

  private static async probe<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Process inspection timed out"));
          }, 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async refresh(proc: OwnedProcess): Promise<ProcessIdentity[]> {
    if (!proc.identity) {
      if (proc.pid <= 0) {
        return [];
      }
      throw new Error(`Unresolved ownership for ${proc.pid}`);
    }
    const live: ProcessIdentity[] = [];
    for (const member of proc.members.values()) {
      const actual = await ProcessRunner.probe(this.deps.readProcessIdentity(member.pid));
      if (actual && sameProcess(member, actual)) {
        live.push(actual);
      }
    }
    const candidates = await ProcessRunner.probe(this.deps.getProcessMembers(proc.identity));
    const [anchor] = live;
    if (anchor) {
      const actual = await ProcessRunner.probe(this.deps.readProcessIdentity(anchor.pid));
      if (!actual || !sameProcess(anchor, actual)) {
        if (candidates.length) {
          throw new Error("Lost ownership anchor");
        }
        return [];
      }
      for (const member of candidates) {
        if (
          member.pgid === proc.identity.pgid &&
          member.sid === proc.identity.sid &&
          !live.some((item) => item.pid === member.pid)
        ) {
          live.push(member);
        }
      }
      for (const member of live) {
        proc.members.set(member.pid, member);
      }
    } else if (candidates.length) {
      throw new Error("Unverified surviving group");
    }
    return live;
  }

  private async signal(proc: OwnedProcess, signal: NodeJS.Signals): Promise<void> {
    const members = await this.refresh(proc);
    const results = await Promise.allSettled(
      members.map(async (member) => {
        const actual = await ProcessRunner.probe(this.deps.readProcessIdentity(member.pid));
        if (actual && sameProcess(member, actual)) {
          try {
            this.deps.kill(member.pid, signal);
          } catch (error) {
            if (
              typeof error !== "object" ||
              error === null ||
              !("code" in error) ||
              error.code !== "ESRCH"
            ) {
              throw error;
            }
          }
        }
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  }

  // Preserve the shared in-flight cleanup promise.
  // oxlint-disable-next-line promise-function-async
  public stop(handle: ExecutionHandle): Promise<void> {
    const proc = this.lookup(handle);
    if (!proc) {
      return Promise.resolve();
    }
    if (proc.stop) {
      return proc.stop;
    }
    proc.stopping = true;
    clearTimeout(proc.monitor);
    proc.stop = this.cleanupAttempt(proc);
    return proc.stop;
  }

  private async cleanup(proc: OwnedProcess): Promise<void> {
    try {
      await proc.ready;
    } catch {
      /* Clean up even when registration failed. */
    }
    ProcessRunner.gate(proc)?.destroy();
    await this.signal(proc, "SIGTERM");
    if (!(await this.waitForExit(proc, STOP_GRACE_MS))) {
      await this.signal(proc, "SIGKILL");
      if (!(await this.waitForExit(proc, KILL_WAIT_MS))) {
        throw new Error("Owned members survived SIGKILL");
      }
    }
    if (proc.pid > 0) {
      await ProcessRunner.probe(Promise.resolve(this.deps.unrecord?.(proc.pid)));
    }
    this.finish(proc);
  }

  private async waitForExit(proc: OwnedProcess, duration: number): Promise<boolean> {
    const deadline = this.deps.now() + duration;
    while (true) {
      const members = await this.refresh(proc);
      if (members.length === 0) {
        return true;
      }
      const remaining = deadline - this.deps.now();
      if (remaining <= 0) {
        return false;
      }
      await this.deps.wait(Math.min(25, remaining));
    }
  }

  private finish(proc: OwnedProcess): void {
    if (proc.finalized) {
      return;
    }
    proc.finalized = true;
    clearTimeout(proc.monitor);
    const trailing = [proc.stdout, proc.stderr].filter(Boolean);
    this.emitLines(proc, trailing);
    proc.child.stdout?.destroy();
    proc.child.stderr?.destroy();
    this.records.delete(proc.handle.id);
    if (this.units.get(proc.handle.unitId) === proc.handle) {
      this.units.delete(proc.handle.unitId);
    }
    if (proc.unexpected) {
      this.deps.onExit(proc.handle.unitId, proc.handle.generation);
    }
  }

  private lookup(handle: ExecutionHandle): OwnedProcess | undefined {
    const proc = this.records.get(handle.id);
    return proc?.handle.unitId === handle.unitId && proc.handle.generation === handle.generation
      ? proc
      : undefined;
  }
  public getHandle(unitId: string): ExecutionHandle | undefined {
    return this.units.get(unitId);
  }
  public getPid(handle: ExecutionHandle): number {
    return this.lookup(handle)?.pid ?? -1;
  }
  public isRunning(handle: ExecutionHandle): boolean {
    const proc = this.lookup(handle);
    return proc !== undefined && !proc.exited;
  }
  public getLines(handle: ExecutionHandle): string[] {
    return this.lookup(handle)?.lines ?? [];
  }
  public async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.records.values()].map(async (proc) => this.stop(proc.handle)),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Process cleanup incomplete",
      );
    }
  }
  public async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopAll();
  }

  private output(proc: OwnedProcess, stream: "stdout" | "stderr", chunk: Buffer): void {
    if (proc.finalized) {
      return;
    }
    const parts = (proc[stream] + chunk.toString()).split("\n");
    proc[stream] = parts.pop() ?? "";
    this.emitLines(proc, parts);
  }
  private emitLines(proc: OwnedProcess, lines: string[]): void {
    if (!lines.length) {
      return;
    }
    proc.lines.push(...lines);
    if (proc.lines.length > 500) {
      proc.lines.splice(0, proc.lines.length - 500);
    }
    this.deps.onLines(proc.handle.unitId, lines);
  }
}
export type { SpawnFn, ProcessSpawnOptions, ProcessRunnerDeps };
