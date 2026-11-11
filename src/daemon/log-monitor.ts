import { acquireTmuxOutput } from "#src/lib/backend/tmux/output.js";
import type { OutputLease } from "#src/lib/backend/tmux/output.js";

import type { LogBuffer } from "./log-buffer.js";

export interface LogMonitorDeps {
  capturePane: (target: string, lines: number) => Promise<string>;
}
export type LogMonitorListener = (key: string, lines: string[]) => void;

export class LogMonitor {
  private readonly subscriptions = new Map<
    string,
    { lease: OutputLease; unsubscribe: () => void }
  >();

  private readonly deps: LogMonitorDeps;
  private readonly buffers: Map<string, LogBuffer>;
  private readonly listener?: LogMonitorListener;

  public constructor(
    deps: LogMonitorDeps,
    buffers: Map<string, LogBuffer>,
    listener?: LogMonitorListener,
  ) {
    this.deps = deps;
    this.buffers = buffers;
    this.listener = listener;
  }

  public start(key: string, paneTarget: string, intervalMs = 500): void {
    if (this.subscriptions.has(key)) {
      return;
    }
    const lease = acquireTmuxOutput(this.deps.capturePane, paneTarget, intervalMs);
    const unsubscribe = lease.producer.subscribe((lines) => {
      this.buffers.get(key)?.appendLines(lines);
      this.listener?.(key, lines);
    });
    this.subscriptions.set(key, { lease, unsubscribe });
  }

  public async flush(key: string): Promise<void> {
    const entry = this.subscriptions.get(key);
    if (!entry) {
      return;
    }
    this.subscriptions.delete(key);
    await entry.lease.flush();
    entry.unsubscribe();
  }

  public stop(key: string): void {
    const entry = this.subscriptions.get(key);
    this.subscriptions.delete(key);
    entry?.unsubscribe();
    entry?.lease.release();
  }

  public async flushAll(): Promise<void> {
    await Promise.all([...this.subscriptions.keys()].map(async (key) => this.flush(key)));
  }

  public stopAll(): void {
    for (const key of this.subscriptions.keys()) {
      this.stop(key);
    }
  }
}
