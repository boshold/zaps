import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import type { ProcessRunnerDeps, SpawnFn } from "#src/lib/backend/runtime/process-runner.js";

export type { SpawnFn };
export interface DetachedSpawnOptions {
  service: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  generation: number;
}
export type DetachedRunnerDeps = ProcessRunnerDeps;

export class DetachedRunner {
  private readonly runner: ProcessRunner;
  public constructor(deps: DetachedRunnerDeps) {
    this.runner = new ProcessRunner(deps);
  }
  public start(opts: DetachedSpawnOptions): number {
    const handle = this.runner.spawnOwned({ ...opts, unitId: opts.service });
    return this.runner.getPid(handle);
  }
  public async stop(service: string): Promise<void> {
    const handle = this.runner.getHandle(service);
    if (handle) {
      await this.runner.stop(handle);
    }
  }
  public async stopAll(): Promise<void> {
    await this.runner.stopAll();
  }
  public async dispose(): Promise<void> {
    await this.runner.dispose();
  }
  public getPid(service: string): number {
    const handle = this.runner.getHandle(service);
    return handle ? this.runner.getPid(handle) : -1;
  }
  public getLines(service: string): string[] {
    const handle = this.runner.getHandle(service);
    return handle ? this.runner.getLines(handle) : [];
  }
  public isRunning(service: string): boolean {
    const handle = this.runner.getHandle(service);
    return handle !== undefined && this.runner.isRunning(handle);
  }
}
