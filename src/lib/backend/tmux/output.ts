import { diffOutput } from "#src/lib/service/output.js";

type CapturePane = (target: string, lines: number) => Promise<string>;
type OutputListener = (lines: string[]) => void;

function executionCapture(baseline: readonly string[], current: string[]): string[] {
  for (const retained of [baseline, baseline.slice(0, -1)]) {
    for (let count = Math.min(retained.length, current.length); count > 0; count -= 1) {
      if (retained.slice(-count).every((line, index) => line === current[index])) {
        return current.slice(count);
      }
    }
  }
  return current;
}

class TmuxOutputProducer {
  private readonly capturePane: CapturePane;
  private readonly target: string;
  private readonly intervalMs: number;
  private readonly listeners = new Set<OutputListener>();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  private revision = 0;
  private previous: string[] = [];
  private readonly baseline?: readonly string[];
  private capture: string[] = [];
  private complete: string[] = [];

  public constructor(
    capturePane: CapturePane,
    target: string,
    intervalMs = 500,
    baseline?: readonly string[],
  ) {
    this.previous = [...(baseline ?? [])];
    this.baseline = baseline === undefined ? undefined : [...baseline];
    this.capturePane = capturePane;
    this.target = target;
    this.intervalMs = intervalMs;
    this.timer = setInterval(() => {
      void this.poll();
    }, intervalMs);
    this.timer.unref();
  }

  public subscribe(listener: OutputListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public reset(): void {
    this.revision += 1;
    if (this.stopped) {
      this.stopped = false;
      this.timer = setInterval(() => {
        void this.poll();
      }, this.intervalMs);
      this.timer.unref();
    }
    this.capture = [];
    this.complete = [];
  }

  public read(tail: number): string[] {
    return tail > 0 ? this.capture.slice(-tail) : [];
  }

  public readComplete(tail: number): string[] {
    return tail > 0 ? this.complete.slice(-tail) : [];
  }

  // oxlint-disable-next-line promise-function-async
  public poll(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    this.pending ??= this.captureOutput();
    return this.pending;
  }

  private async captureOutput(): Promise<void> {
    const { revision } = this;
    try {
      const output = await this.capturePane(this.target, 500);
      if (this.stopped || revision !== this.revision) {
        return;
      }
      const current = output === "" ? [] : output.split("\n");
      const lines = diffOutput(this.previous, current);
      this.previous = current;
      this.capture =
        this.baseline === undefined ? current : executionCapture(this.baseline, current);
      this.complete = this.capture.slice(0, -1);
      if (lines.length) {
        for (const listener of this.listeners) {
          listener(lines);
        }
      }
    } catch {
      if (revision === this.revision) {
        this.stopped = true;
        clearInterval(this.timer);
        this.timer = undefined;
        this.capture = [];
        this.complete = [];
      }
    } finally {
      this.pending = undefined;
    }
  }

  public snapshot(): string[] {
    return [...this.previous];
  }

  public stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  public async drain(): Promise<void> {
    await this.pending;
  }

  public async flush(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
    this.stop();
  }
}

interface OutputLease {
  producer: TmuxOutputProducer;
  release: () => void;
  flush: () => Promise<void>;
}

// Legacy composition bridge: session consumers share their bound capture dependency.
const sources = new WeakMap<
  CapturePane,
  Map<string, { producer: TmuxOutputProducer; users: number }>
>();
function acquireTmuxOutput(capture: CapturePane, target: string, intervalMs = 500): OutputLease {
  let panes = sources.get(capture);
  if (!panes) {
    panes = new Map();
    sources.set(capture, panes);
  }
  let entry = panes.get(target);
  if (!entry) {
    entry = { producer: new TmuxOutputProducer(capture, target, intervalMs), users: 0 };
    panes.set(target, entry);
  }
  entry.users += 1;
  const owned = entry;
  const registry = panes;
  let released = false;
  const detach = (): boolean => {
    if (released) {
      return false;
    }
    released = true;
    owned.users -= 1;
    if (owned.users) {
      return false;
    }
    if (registry.get(target) === owned) {
      registry.delete(target);
    }
    return true;
  };
  return {
    producer: owned.producer,
    release: () => {
      if (detach()) {
        owned.producer.stop();
      }
    },
    flush: async () => {
      await (detach() ? owned.producer.flush() : owned.producer.drain());
    },
  };
}

function cachedTmuxOutput(capture: CapturePane, target: string, tail: number): string[] {
  return sources.get(capture)?.get(target)?.producer.read(tail) ?? [];
}

export { TmuxOutputProducer, acquireTmuxOutput, cachedTmuxOutput, diffOutput };
export type { CapturePane, OutputLease };
