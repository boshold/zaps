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
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private prevCaptures = new Map<string, string[]>();
  private deps: LogMonitorDeps;
  private buffers: Map<string, LogBuffer>;
  private listener?: LogMonitorListener;

  constructor(
    deps: LogMonitorDeps,
    buffers: Map<string, LogBuffer>,
    listener?: LogMonitorListener,
  ) {
    this.deps = deps;
    this.buffers = buffers;
    this.listener = listener;
  }

  start(serviceName: string, paneTarget: string, intervalMs = 500): void {
    if (this.timers.has(serviceName)) {
      return;
    }

    this.prevCaptures.set(serviceName, []);
    let fetching = false;

    const timer = setInterval(() => {
      if (fetching) {
        return;
      }
      fetching = true;
      void (async () => {
        try {
          const output = await this.deps.capturePane(paneTarget, 500);
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
    }, intervalMs);

    this.timers.set(serviceName, timer);
  }

  stop(serviceName: string): void {
    const timer = this.timers.get(serviceName);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(serviceName);
      this.prevCaptures.delete(serviceName);
    }
  }

  stopAll(): void {
    for (const [name] of this.timers) {
      this.stop(name);
    }
  }
}
