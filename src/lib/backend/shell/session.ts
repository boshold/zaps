import type { LayoutNode, ServiceConfig } from "#src/config/types.js";
import { preflightBackendCompatibility } from "#src/lib/backend/compatibility.js";
import { ProcessRunner } from "#src/lib/backend/runtime/process-runner.js";
import type {
  ProcessAuthority,
  ProcessRunnerDeps,
} from "#src/lib/backend/runtime/process-runner.js";
import { ShellRuntime } from "#src/lib/backend/shell/runtime.js";
import type {
  BackendCapabilities,
  PresentationSnapshot,
  SessionBackend,
} from "#src/lib/backend/types.js";

const shellCapabilities = Object.freeze({
  panes: false,
  zoom: false,
  popups: false,
  taskPanes: false,
  rawInput: false,
  layout: false,
}) satisfies BackendCapabilities;

interface ShellSessionOptions {
  services: Readonly<Record<string, ServiceConfig>>;
  layout?: LayoutNode;
  processes?: Partial<ProcessRunnerDeps>;
  authority?: ProcessAuthority;
}

class ShellSessionBackend implements SessionBackend {
  public readonly id = "shell";
  public readonly capabilities = shellCapabilities;
  public readonly runtime: ShellRuntime;
  private readonly presentation: PresentationSnapshot = Object.freeze({ kind: "shell" });
  private disposed = false;
  private disposal?: Promise<void>;

  private constructor(options: ShellSessionOptions) {
    this.runtime = new ShellRuntime(
      new ProcessRunner({
        onLines: () => {
          /* Events own output. */
        },
        onExit: () => {
          /* Events own exits. */
        },
        ...options.processes,
      }),
      options.authority,
    );
  }

  public static async create(options: ShellSessionOptions): Promise<ShellSessionBackend> {
    preflightBackendCompatibility(options.services, shellCapabilities);
    return new ShellSessionBackend(options);
  }

  public getPresentation(): PresentationSnapshot {
    return this.presentation;
  }

  public subscribePresentation(_listener: (view: PresentationSnapshot) => void): () => void {
    if (this.disposed) {
      throw new Error("Shell host disposed");
    }
    return () => {
      /* No presentation changes. */
    };
  }

  public async health(): Promise<"alive" | "lost"> {
    return this.disposed ? "lost" : "alive";
  }

  public async retryCleanup(): Promise<void> {
    this.disposed = true;
    await this.runtime.dispose();
  }

  // oxlint-disable-next-line promise-function-async
  public dispose(): Promise<void> {
    this.disposed = true;
    this.disposal ??= this.runtime.dispose();
    return this.disposal;
  }
}

export { ShellSessionBackend, shellCapabilities };
export type { ShellSessionOptions };
