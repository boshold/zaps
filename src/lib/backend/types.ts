type BackendId = "tmux" | "shell";

interface BackendCapabilities {
  readonly panes: boolean;
  readonly zoom: boolean;
  readonly popups: boolean;
  readonly taskPanes: boolean;
  readonly rawInput: boolean;
  readonly layout: boolean;
}

interface ServiceActions {
  readonly focus: boolean;
  readonly zoom: boolean;
  readonly editOutput: boolean;
}

interface ExecutionHandle {
  readonly id: string;
  readonly unitId: string;
  readonly generation: number;
}

interface ExecutionSpec {
  readonly unitId: string;
  readonly generation: number;
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly placement: "default" | "background";
  readonly raw: boolean;
}

type ExecutionIdentity = Pick<ExecutionSpec, "unitId" | "generation">;
interface ExitDetails {
  readonly code: number | null;
  readonly signal: string | null;
  readonly spawnError?: string;
}

type ExecutionEvent = ExecutionIdentity &
  (
    | ({ readonly kind: "leaderExit" } & ExitDetails)
    | { readonly kind: "output"; readonly lines: readonly string[] }
    | ({
        readonly kind: "exit";
        readonly cleanupError?: string;
        readonly drainTimedOut?: boolean;
      } & ExitDetails)
  );

interface RuntimeDriver {
  start(spec: ExecutionSpec): Promise<ExecutionHandle>;
  stop(handle: ExecutionHandle): Promise<void>;
  isRunning(handle: ExecutionHandle): Promise<boolean>;
  getPid(handle: ExecutionHandle): Promise<number | undefined>;
  readOutput(handle: ExecutionHandle, tail: number): Promise<string[]>;
  subscribe(listener: (event: ExecutionEvent) => void): () => void;
}

type PresentationSnapshot =
  | { readonly kind: "shell" }
  | {
      readonly kind: "tmux";
      readonly tmuxSession: string;
      readonly tmuxWindow: string;
      readonly originPane: string;
      readonly tmuxSocket: string | null;
      readonly managedTmux: boolean;
      readonly paneMap: Readonly<Record<string, string>>;
      readonly focusPane?: string;
    };

type TerminalTarget =
  | { readonly kind: "service"; readonly name: string }
  | { readonly kind: "dashboard" };

type PresentationPlan =
  | {
      readonly kind: "leaf";
      readonly target: TerminalTarget;
      readonly size?: string;
      readonly focus?: boolean;
    }
  | {
      readonly kind: "split";
      readonly direction: "rows" | "columns";
      readonly children: readonly PresentationPlan[];
      readonly size?: string;
    };

interface TerminalOperation {
  readonly id: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

interface TaskPaneSpec {
  readonly taskKey: string;
  readonly runId: string;
  readonly execution: ExecutionSpec;
}

interface TerminalDriver {
  reconcileLayout(plan: PresentationPlan): Promise<void>;
  focus(target: TerminalTarget): Promise<void>;
  zoom(target: TerminalTarget): Promise<void>;
  editOutput(service: string, operation: TerminalOperation): Promise<void>;
  taskPicker(operation: TerminalOperation): Promise<string | null>;
  taskOutput(runId: string, operation: TerminalOperation): Promise<void>;
  runTaskInPane(spec: TaskPaneSpec, operation: TerminalOperation): Promise<ExecutionHandle>;
}

interface SessionBackend {
  readonly id: BackendId;
  readonly capabilities: BackendCapabilities;
  readonly runtime: RuntimeDriver;
  readonly terminal?: TerminalDriver;
  getPresentation(): PresentationSnapshot;
  subscribePresentation(listener: (view: PresentationSnapshot) => void): () => void;
  health(): Promise<"alive" | "lost">;
  dispose(): Promise<void>;
}

export type {
  BackendId,
  BackendCapabilities,
  ServiceActions,
  ExecutionHandle,
  ExecutionSpec,
  ExecutionEvent,
  RuntimeDriver,
  PresentationSnapshot,
  TerminalTarget,
  PresentationPlan,
  TerminalOperation,
  TaskPaneSpec,
  TerminalDriver,
  SessionBackend,
};
