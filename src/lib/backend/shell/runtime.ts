import type { ProcessAuthority, ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import type {
  ExecutionEvent,
  ExecutionHandle,
  ExecutionSpec,
  RuntimeDriver,
} from "#src/lib/backend/types.js";

class ShellRuntime implements RuntimeDriver {
  private readonly processes: ProcessRunner;
  private readonly authority?: ProcessAuthority;

  public constructor(processes: ProcessRunner, authority?: ProcessAuthority) {
    this.processes = processes;
    this.authority = authority;
  }

  public closeAdmission(): void {
    this.processes.closeAdmission();
  }

  public async start(spec: ExecutionSpec): Promise<ExecutionHandle> {
    if (spec.raw) {
      throw new Error(`unsupported_config: raw input is unsupported for '${spec.unitId}'`);
    }
    return this.processes.spawnOwned({ ...spec, authority: this.authority });
  }

  public async stop(handle: ExecutionHandle): Promise<void> {
    await this.processes.stop(handle);
  }

  public async isRunning(handle: ExecutionHandle): Promise<boolean> {
    return this.processes.isRunning(handle);
  }

  public async getPid(handle: ExecutionHandle): Promise<number | undefined> {
    const pid = this.processes.getPid(handle);
    return pid > 0 ? pid : undefined;
  }

  public async readOutput(handle: ExecutionHandle, tail: number): Promise<string[]> {
    return this.processes.readOutput(handle, tail);
  }

  public subscribe(listener: (event: ExecutionEvent) => void): () => void {
    return this.processes.subscribe(listener);
  }

  public async dispose(): Promise<void> {
    await this.processes.dispose();
  }
}

export { ShellRuntime };
