import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";

import type { ExecutionEvent, ExecutionHandle } from "#src/lib/backend/types.js";

import { createProcessInspection, sameProcess } from "./process-inspection.js";
import type { ProcessIdentity } from "./process-inspection.js";

const STOP_GRACE_MS = 5000;
const KILL_WAIT_MS = 1000;
const DRAIN_WAIT_MS = 1000;
const GATE_COMMAND = 'read -r zaps_gate <&3 || exit 125; exec 3<&-; exec sh -c "$1"';

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
interface ProcessAuthority {
  readonly signal: AbortSignal;
}

class ProcessAdmission {
  private state: "active" | "closing" | "disposed" = "active";
  private readonly scopes = new Map<
    ProcessAuthority,
    {
      controller: AbortController;
      deadline: number;
      cleanup: boolean;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  public readonly normal: ProcessAuthority;

  public constructor() {
    this.normal = this.issue(false, Infinity);
  }

  private issue(cleanup: boolean, deadline: number): ProcessAuthority {
    const controller = new AbortController();
    const authority = Object.freeze({ signal: controller.signal });
    this.scopes.set(authority, { controller, deadline, cleanup });
    return authority;
  }

  public allows(authority: ProcessAuthority | undefined): boolean {
    const scope = authority && this.scopes.get(authority);
    return Boolean(
      scope &&
      this.state !== "disposed" &&
      !scope.controller.signal.aborted &&
      Date.now() < scope.deadline &&
      (scope.cleanup || this.state === "active"),
    );
  }

  public close(): void {
    if (this.state === "active") {
      this.state = "closing";
    }
  }

  public createCleanupScope(deadline: number): { authority: ProcessAuthority; revoke: () => void } {
    if (this.state === "disposed" || !Number.isFinite(deadline) || deadline <= Date.now()) {
      throw new Error("session_closing");
    }
    const authority = this.issue(true, deadline);
    const revoke = () => {
      const scope = this.scopes.get(authority);
      if (scope) {
        clearTimeout(scope.timer);
        scope.controller.abort();
        this.scopes.delete(authority);
      }
    };
    const scope = this.scopes.get(authority);
    if (scope) {
      scope.timer = setTimeout(revoke, Math.min(deadline - Date.now(), 2_147_483_647));
    }
    return { authority, revoke };
  }

  public dispose(): void {
    this.state = "disposed";
    for (const scope of this.scopes.values()) {
      clearTimeout(scope.timer);
      scope.controller.abort();
    }
    this.scopes.clear();
  }
}

interface ProcessSpawnOptions {
  authority?: ProcessAuthority;
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
  admission?: ProcessAdmission;
  readProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
  getProcessMembers?: (identity: ProcessIdentity) => Promise<ProcessIdentity[]>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  diagnostic?: (message: string) => void;
}
class CleanupDeadlineError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CleanupDeadlineError";
  }
}

interface OwnedProcess {
  handle: ExecutionHandle;
  authority?: ProcessAuthority;
  removeAbort?: () => void;
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
  gateReleased: boolean;
  childCompleted: boolean;
  code: number | null;
  signal: string | null;
  spawnError?: string;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  closed: Set<"stdout" | "stderr">;
  drain?: Promise<boolean>;
  streamsChanged?: () => void;
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
  private readonly listeners = new Set<(event: ExecutionEvent) => void>();

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

  public admits(authority?: ProcessAuthority): boolean {
    return (
      !this.disposed &&
      this.deps.admit?.() !== false &&
      (!this.deps.admission || this.deps.admission.allows(authority))
    );
  }

  public spawnOwned(opts: ProcessSpawnOptions): ExecutionHandle {
    if (!this.admits(opts.authority)) {
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
      authority: opts.authority,
      child,
      pid: child.pid ?? -1,
      members: new Map(),
      ready: Promise.resolve(),
      stopping: false,
      exited: false,
      finalized: false,
      unexpected: false,
      gateReleased: false,
      childCompleted: false,
      code: null,
      signal: null,
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      closed: new Set(),
      stdout: "",
      stderr: "",
      lines: [],
    };
    this.records.set(handle.id, proc);
    this.units.set(opts.unitId, handle);
    for (const stream of ["stdout", "stderr"] as const) {
      const readable = child[stream];
      if (!readable) {
        proc.closed.add(stream);
        continue;
      }
      readable.on("data", (chunk: Buffer) => {
        this.output(proc, stream, proc[`${stream}Decoder`].write(chunk));
      });
      const closed = () => {
        this.closeStream(proc, stream);
      };
      readable.once("end", closed);
      readable.once("close", closed);
    }
    const exited = (completed: boolean) => {
      proc.childCompleted ||= completed;
      if (proc.exited) {
        if (completed && (!proc.gateReleased || proc.finalized) && this.lookup(handle)) {
          void this.stopObserved(handle);
        }
        return;
      }
      proc.exited = true;
      proc.unexpected ||= !proc.stopping;
      clearTimeout(proc.monitor);
      this.publish(proc, { kind: "leaderExit", ...ProcessRunner.exitDetails(proc) });
      void this.stopObserved(handle);
    };
    child.on("exit", (code, signal) => {
      proc.code = code;
      proc.signal = signal;
      exited(true);
    });
    child.on("error", (error) => {
      proc.spawnError ??= error.message;
      exited(proc.pid <= 0);
    });
    const cancel = () => {
      void this.stopObserved(handle);
    };
    opts.authority?.signal.addEventListener("abort", cancel, { once: true });
    proc.removeAbort = () => {
      opts.authority?.signal.removeEventListener("abort", cancel);
    };
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
      proc.unexpected ||= !proc.stopping;
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
      await this.finish(proc, String(error));
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
    const identity = await this.probe(async () => this.deps.readProcessIdentity(proc.pid));
    if (proc.finalized) {
      return;
    }
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
    await this.probe(async () => this.deps.record?.(proc.pid));
    await this.refresh(proc);
    const gate = ProcessRunner.gate(proc);
    gate?.on("error", () => {
      /* Gate closure is expected during cleanup. */
    });
    if (proc.stopping || proc.exited || !this.admits(proc.authority)) {
      gate?.destroy();
    } else {
      if (!gate) {
        throw new Error("Missing payload gate");
      }
      proc.gateReleased = true;
      gate.end("run\n");
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

  private async probe<T>(operation: () => Promise<T>, deadline = Infinity): Promise<T> {
    const remaining = deadline - this.deps.now();
    if (remaining <= 0) {
      throw new CleanupDeadlineError("Process cleanup deadline exceeded");
    }
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              reject(
                remaining <= 1000
                  ? new CleanupDeadlineError("Process cleanup deadline exceeded")
                  : new Error("Process inspection timed out"),
              );
            },
            Math.min(1000, remaining),
          );
        }),
      ]);
      if (this.deps.now() > deadline) {
        throw new CleanupDeadlineError("Process cleanup deadline exceeded");
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async refresh(proc: OwnedProcess, deadline = Infinity): Promise<ProcessIdentity[]> {
    if (!proc.identity) {
      if (proc.pid <= 0) {
        return [];
      }
      throw new Error(`Unresolved ownership for ${proc.pid}`);
    }
    const { identity } = proc;
    const live: ProcessIdentity[] = [];
    for (const member of proc.members.values()) {
      const actual = await this.probe(
        async () => this.deps.readProcessIdentity(member.pid),
        deadline,
      );
      if (actual && sameProcess(member, actual)) {
        live.push(actual);
      }
    }
    const candidates = await this.probe(
      async () => this.deps.getProcessMembers(identity),
      deadline,
    );
    const [anchor] = live;
    if (anchor) {
      const actual = await this.probe(
        async () => this.deps.readProcessIdentity(anchor.pid),
        deadline,
      );
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

  private async signal(
    proc: OwnedProcess,
    signal: NodeJS.Signals,
    deadline: number,
  ): Promise<void> {
    const members =
      signal === "SIGKILL" ? [...proc.members.values()] : await this.refresh(proc, deadline);
    const results = await Promise.allSettled(
      members.map(async (member) => {
        const actual = await this.probe(
          async () => this.deps.readProcessIdentity(member.pid),
          deadline,
        );
        if (actual && sameProcess(member, actual)) {
          if (this.deps.now() >= deadline) {
            throw new CleanupDeadlineError("Process cleanup deadline exceeded");
          }
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
    const termDeadline = this.deps.now() + STOP_GRACE_MS;
    const killDeadline = termDeadline + KILL_WAIT_MS;
    try {
      await this.probe(async () => proc.ready, termDeadline);
    } catch {
      /* Clean up even when registration failed. */
    }
    ProcessRunner.gate(proc)?.destroy();
    if (!proc.gateReleased && !proc.identity) {
      while (!proc.childCompleted) {
        const remaining = termDeadline - this.deps.now();
        if (remaining <= 0) {
          throw new Error(`Unresolved ownership for ${proc.pid}`);
        }
        await this.deps.wait(Math.min(25, remaining));
      }
      await this.finish(proc);
      return;
    }
    if (!(proc.childCompleted && !proc.gateReleased)) {
      await this.signal(proc, "SIGTERM", termDeadline);
      if (!(await this.waitForExit(proc, termDeadline))) {
        await this.signal(proc, "SIGKILL", killDeadline);
        if (!(await this.waitForExit(proc, killDeadline))) {
          throw new Error("Owned members survived SIGKILL or cleanup verification deadline");
        }
      }
    }
    if (proc.pid > 0) {
      await this.probe(async () => this.deps.unrecord?.(proc.pid), killDeadline);
    }
    await this.finish(proc);
  }

  private async waitForExit(proc: OwnedProcess, deadline: number): Promise<boolean> {
    while (this.deps.now() < deadline) {
      try {
        const members = await this.refresh(proc, deadline);
        if (members.length === 0) {
          return true;
        }
      } catch (error) {
        if (error instanceof CleanupDeadlineError) {
          return false;
        }
        throw error;
      }
      const remaining = deadline - this.deps.now();
      if (remaining <= 0) {
        return false;
      }
      await this.deps.wait(Math.min(25, remaining));
    }
    return false;
  }

  private static exitDetails(proc: OwnedProcess) {
    return {
      code: proc.code,
      signal: proc.signal,
      ...(proc.spawnError ? { spawnError: proc.spawnError } : {}),
    };
  }

  public subscribe(listener: (event: ExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(
    proc: OwnedProcess,
    event:
      | Omit<Extract<ExecutionEvent, { kind: "leaderExit" }>, "unitId" | "generation">
      | Omit<Extract<ExecutionEvent, { kind: "exit" }>, "unitId" | "generation">
      | Omit<Extract<ExecutionEvent, { kind: "output" }>, "unitId" | "generation">,
  ): void {
    for (const listener of this.listeners) {
      listener({ ...event, unitId: proc.handle.unitId, generation: proc.handle.generation });
    }
  }

  private closeStream(proc: OwnedProcess, stream: "stdout" | "stderr"): void {
    if (proc.closed.has(stream)) {
      return;
    }
    this.output(proc, stream, proc[`${stream}Decoder`].end());
    proc.closed.add(stream);
    const trailing = proc[stream];
    proc[stream] = "";
    if (trailing) {
      this.emitLines(proc, [trailing]);
    }
    proc.streamsChanged?.();
  }

  private async drain(proc: OwnedProcess): Promise<boolean> {
    if (proc.closed.size === 2) {
      return false;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.streamsChanged = undefined;
        for (const stream of ["stdout", "stderr"] as const) {
          this.closeStream(proc, stream);
          proc.child[stream]?.destroy();
        }
        resolve(true);
      }, DRAIN_WAIT_MS);
      proc.streamsChanged = () => {
        if (proc.closed.size === 2) {
          clearTimeout(timer);
          proc.streamsChanged = undefined;
          resolve(false);
        }
      };
    });
  }

  private async finish(proc: OwnedProcess, cleanupError?: string): Promise<void> {
    proc.drain ??= this.drain(proc);
    const drainTimedOut = await proc.drain;
    if (!cleanupError) {
      proc.removeAbort?.();
      this.records.delete(proc.handle.id);
      if (this.units.get(proc.handle.unitId) === proc.handle) {
        this.units.delete(proc.handle.unitId);
      }
    }
    if (proc.finalized) {
      return;
    }
    proc.finalized = true;
    clearTimeout(proc.monitor);
    this.publish(proc, {
      kind: "exit",
      ...ProcessRunner.exitDetails(proc),
      ...(cleanupError ? { cleanupError } : {}),
      ...(drainTimedOut ? { drainTimedOut } : {}),
    });
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
  public readOutput(handle: ExecutionHandle, tail: number): string[] {
    const proc = this.lookup(handle);
    return proc && tail > 0
      ? [...proc.lines, ...[proc.stdout, proc.stderr].filter(Boolean)].slice(-Math.min(tail, 500))
      : [];
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
    this.deps.admission?.dispose();
    await this.stopAll();
  }

  private output(proc: OwnedProcess, stream: "stdout" | "stderr", chunk: string): void {
    if (proc.finalized) {
      return;
    }
    const parts = (proc[stream] + chunk).split("\n");
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
    this.publish(proc, { kind: "output", lines });
  }
}
export type { SpawnFn, ProcessSpawnOptions, ProcessRunnerDeps };

export { ProcessAdmission };
export type { ProcessAuthority };
