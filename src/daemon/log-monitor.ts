import { diffOutput } from "#src/lib/service/manager.js";

import type { LogBuffer } from "./log-buffer.js";

export interface LogMonitorDeps {
  capturePane: (target: string, lines: number) => Promise<string>;
}

/** `key` is the monitor key — a pane id; the session maps it back to members. */
export type LogMonitorListener = (key: string, lines: string[]) => void;

/**
 * Polls tmux panes and pushes new lines into LogBuffers, keyed by pane id.
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

  public start(key: string, paneTarget: string, intervalMs = 500): void {
    if (this.timers.has(key)) {
      return;
    }

    this.prevCaptures.set(key, []);
    this.stopped.delete(key);
    let fetching = false;

    const timer = setInterval(() => {
      if (fetching || this.stopped.has(key)) {
        return;
      }
      fetching = true;
      const capture = (async () => {
        try {
          if (this.stopped.has(key)) {
            return;
          }
          const output = await this.deps.capturePane(paneTarget, 500);
          if (this.stopped.has(key)) {
            return;
          }
          const currentLines = output.split("\n");
          const prev = this.prevCaptures.get(key) ?? [];
          const newLines = diffOutput(prev, currentLines);
          this.prevCaptures.set(key, currentLines);

          if (newLines.length > 0) {
            const buffer = this.buffers.get(key);
            if (buffer) {
              buffer.appendLines(newLines);
            }
            this.listener?.(key, newLines);
          }
        } catch {
          /* Pane may have been destroyed during shutdown — ignore */
        } finally {
          fetching = false;
        }
      })();
      this.inFlight.set(key, capture);
    }, intervalMs);

    this.timers.set(key, timer);
  }

  /**
   * Stop monitoring and wait for any in-flight capture to finish.
   */
  public async flush(key: string): Promise<void> {
    this.stopped.add(key);
    const timer = this.timers.get(key);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(key);
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      await pending;
    }
    this.inFlight.delete(key);
    this.prevCaptures.delete(key);
  }

  /**
   * Synchronous stop. Mirrors `flush()` bookkeeping — unconditionally drops the
   * `inFlight` and `prevCaptures` entries (and clears the timer when present) so
   * maps never grow across service restarts / reloads (D6).
   */
  public stop(key: string): void {
    this.stopped.add(key);
    const timer = this.timers.get(key);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(key);
    }
    this.inFlight.delete(key);
    this.prevCaptures.delete(key);
  }

  public async flushAll(): Promise<void> {
    const keys = [...this.timers.keys()];
    await Promise.all(keys.map(async (key) => this.flush(key)));
  }

  public stopAll(): void {
    const keys = [...this.timers.keys()];
    for (const key of keys) {
      this.stop(key);
    }
  }
}
