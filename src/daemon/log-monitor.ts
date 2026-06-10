import { diffOutput } from "#src/lib/service/manager.js";

import type { LogBuffer } from "./log-buffer.js";

export interface LogMonitorDeps {
  capturePane: (target: string, lines: number) => Promise<string>;
}

export type LogMonitorListener = (serviceName: string, lines: string[]) => void;

/**
 * Polls tmux panes and pushes new lines into LogBuffers.
 * Broadcasts new lines to a listener (for daemon event broadcasting).
 */
export class LogMonitor {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly prevCaptures = new Map<string, string[]>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly stopped = new Set<string>();
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

  public start(serviceName: string, paneTarget: string, intervalMs = 500): void {
    if (this.timers.has(serviceName)) {
      return;
    }

    this.prevCaptures.set(serviceName, []);
    this.stopped.delete(serviceName);
    let fetching = false;

    const timer = setInterval(() => {
      if (fetching || this.stopped.has(serviceName)) {
        return;
      }
      fetching = true;
      const capture = (async () => {
        try {
          if (this.stopped.has(serviceName)) {
            return;
          }
          const output = await this.deps.capturePane(paneTarget, 500);
          if (this.stopped.has(serviceName)) {
            return;
          }
          const currentLines = output.split("\n");
          const prev = this.prevCaptures.get(serviceName) ?? [];
          const newLines = diffOutput(prev, currentLines);
          this.prevCaptures.set(serviceName, currentLines);

          if (newLines.length > 0) {
            const buffer = this.buffers.get(serviceName);
            if (buffer) {
              buffer.appendLines(newLines);
            }
            this.listener?.(serviceName, newLines);
          }
        } catch {
          /* Pane may have been destroyed during shutdown — ignore */
        } finally {
          fetching = false;
        }
      })();
      this.inFlight.set(serviceName, capture);
    }, intervalMs);

    this.timers.set(serviceName, timer);
  }

  /**
   * Stop monitoring and wait for any in-flight capture to finish.
   */
  public async flush(serviceName: string): Promise<void> {
    this.stopped.add(serviceName);
    const timer = this.timers.get(serviceName);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(serviceName);
    }
    const pending = this.inFlight.get(serviceName);
    if (pending) {
      await pending;
    }
    this.inFlight.delete(serviceName);
    this.prevCaptures.delete(serviceName);
  }

  public stop(serviceName: string): void {
    this.stopped.add(serviceName);
    const timer = this.timers.get(serviceName);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(serviceName);
      this.prevCaptures.delete(serviceName);
    }
  }

  public async flushAll(): Promise<void> {
    const names = [...this.timers.keys()];
    await Promise.all(names.map(async (name) => this.flush(name)));
  }

  public stopAll(): void {
    for (const [name] of this.timers) {
      this.stop(name);
    }
  }
}
