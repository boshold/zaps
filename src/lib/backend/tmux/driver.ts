import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { LayoutNode } from "#src/config/types.js";
import { TerminalOperationError, editOperationCapture } from "#src/lib/backend/tmux/operations.js";
import type {
  TerminalOperationContext,
  TmuxTerminalOperations,
} from "#src/lib/backend/tmux/operations.js";
import type {
  ConfiguredTaskCommand,
  ConfiguredTaskOutcome,
  ExecutionHandle,
  PresentationPlan,
  TaskPaneSpec,
  TerminalDriver,
  TerminalOperation,
  TerminalTarget,
} from "#src/lib/backend/types.js";
import { shellEscape } from "#src/lib/service/env.js";
import { showOutputPopup } from "#src/lib/task/output-popup.js";
import { popupPickerAvailable, runPopupPicker } from "#src/lib/task/popup-picker.js";
import type { PopupTask } from "#src/lib/task/popup-picker.js";
import type { TmuxHandle } from "#src/lib/tmux.js";

interface DriverOptions {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly tmux: TmuxHandle;
  readonly dashboardPane: string;
  readonly operations: TmuxTerminalOperations;
  paneFor(name: string): string;
  taskPane(runId: string, pane: string): void;
  tasks(): PopupTask[];
  output(runId: string): { taskKey: string; lines: string[] } | undefined;
  reconcile(layout: LayoutNode): Promise<void>;
}

function layoutNode(plan: PresentationPlan): LayoutNode {
  if (plan.kind === "leaf") {
    return {
      pane: plan.target.kind === "dashboard" ? "@tui" : plan.target.name,
      size: plan.size,
      focus: plan.focus,
    };
  }
  return { direction: plan.direction, children: plan.children.map(layoutNode), size: plan.size };
}

class TmuxTerminalDriver implements TerminalDriver {
  private readonly taskPanes = new Map<string, { handle: ExecutionHandle; pane: string }>();
  private readonly options: DriverOptions;
  private disposed = false;

  public constructor(options: DriverOptions) {
    this.options = options;
  }

  public async detachHost(operation: TerminalOperation, isCurrent: () => boolean): Promise<void> {
    await this.options.operations.detachHost(
      { kind: "ui", socketId: operation.id, sessionId: this.options.sessionId },
      () => !operation.signal.aborted && isCurrent(),
    );
  }

  public async reconcileLayout(plan: PresentationPlan): Promise<void> {
    await this.options.reconcile(layoutNode(plan));
  }

  private async pane(target: TerminalTarget): Promise<string> {
    try {
      const pane =
        target.kind === "dashboard"
          ? this.options.dashboardPane
          : this.options.paneFor(target.name);
      const format = "#{session_id}\t#{window_id}";
      const [dashboard, identity] = await Promise.all([
        this.options.tmux.displayMessage(this.options.dashboardPane, format),
        this.options.tmux.displayMessage(pane, format),
      ]);
      if (!identity || identity !== dashboard || !(await this.options.tmux.paneExists(pane))) {
        throw new Error("Stale terminal target");
      }
      return pane;
    } catch (error) {
      throw new TerminalOperationError("backend_unavailable", false, { cause: error });
    }
  }

  public async focus(target: TerminalTarget): Promise<void> {
    await this.options.operations.assertClientAvailable();
    await this.options.tmux.selectPane(await this.pane(target));
  }

  public async zoom(target: TerminalTarget): Promise<void> {
    await this.options.operations.assertClientAvailable();
    await this.options.tmux.zoomPane(await this.pane(target));
  }

  private async popup<T>(
    operation: TerminalOperation,
    action: (context: TerminalOperationContext) => Promise<T>,
  ): Promise<T> {
    return this.options.operations.run(
      {
        owner: { kind: "ui", socketId: operation.id, sessionId: this.options.sessionId },
        cwd: operation.cwd,
        env: operation.env,
        signal: operation.signal,
      },
      async (context) => {
        if (!(await this.options.tmux.tmuxSupportsPopup())) {
          throw new TerminalOperationError("backend_unavailable");
        }
        return action(context);
      },
    );
  }

  public async runConfiguredTask(
    command: ConfiguredTaskCommand,
    operation: TerminalOperation,
  ): Promise<ConfiguredTaskOutcome> {
    try {
      return await this.options.operations.run(
        {
          owner: { kind: "task", runId: operation.id, sessionId: this.options.sessionId },
          cwd: operation.cwd,
          env: operation.env,
          signal: operation.signal,
        },
        async (context) => {
          if (!(await this.options.tmux.tmuxSupportsPopup())) {
            throw new TerminalOperationError("backend_unavailable");
          }
          const statusFile = path.join(context.directory, "exit-code");
          const commands = command.commands.map((value) => `sh -c ${shellEscape(value)}`);
          const script = `${commands.join(" && ")}
status=$?
printf '%s' "$status" > ${shellEscape(statusFile)}`;
          await context.popup({
            command: `sh -c ${shellEscape(script)}`,
            title: command.title,
            width: command.width,
            height: command.height,
          });
          const status = await readFile(statusFile, "utf8");
          const exitCode = z.coerce
            .number()
            .int()
            .min(0)
            .max(255)
            .parse(z.string().regex(/^\d+$/).parse(status));
          return { kind: "completed", exitCode };
        },
      );
    } catch (error) {
      if (
        error instanceof TerminalOperationError &&
        error.code === "backend_unavailable" &&
        !error.launched
      ) {
        return { kind: "unavailable" };
      }
      throw error;
    }
  }

  public async editOutput(service: string, operation: TerminalOperation): Promise<void> {
    await this.popup(operation, async (context) =>
      editOperationCapture(context, await this.pane({ kind: "service", name: service }), service),
    );
  }

  public async taskPicker(operation: TerminalOperation): Promise<string | null> {
    return this.popup(operation, async (context) => {
      if (!(await popupPickerAvailable(this.options.tmux, context.env))) {
        throw new TerminalOperationError("backend_unavailable");
      }
      const selected = await runPopupPicker(this.options.tasks(), { operation: context });
      if (selected !== null && !this.options.tasks().some((task) => task.key === selected)) {
        throw new TerminalOperationError("backend_unavailable");
      }
      return selected;
    });
  }

  public async taskOutput(runId: string, operation: TerminalOperation): Promise<void> {
    await this.popup(operation, async (context) => {
      const output = this.options.output(runId);
      if (!output) {
        throw new TerminalOperationError("backend_unavailable");
      }
      await showOutputPopup(output.taskKey, output.lines, context);
    });
  }

  public async runTaskInPane(
    spec: TaskPaneSpec,
    operation: TerminalOperation,
  ): Promise<ExecutionHandle> {
    operation.signal.throwIfAborted();
    if (this.disposed) {
      throw new Error("Terminal driver disposed");
    }
    const pane =
      spec.target === "pane"
        ? await this.options.tmux.splitPane(this.options.dashboardPane, "v")
        : await this.options.tmux.newWindow(this.options.sessionName);
    const handle: ExecutionHandle = Object.freeze({
      id: randomUUID(),
      unitId: spec.execution.unitId,
      generation: spec.execution.generation,
    });
    this.taskPanes.set(handle.id, { handle, pane });
    try {
      operation.signal.throwIfAborted();
      if (this.disposed) {
        throw new Error("Terminal driver disposed");
      }
      this.options.taskPane(spec.runId, pane);
      await this.options.tmux.sendKeys(pane, spec.execution.command);
      return handle;
    } catch (error) {
      await this.options.tmux.killPane(pane);
      this.taskPanes.delete(handle.id);
      throw error;
    }
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    const errors: unknown[] = [];
    for (const [id, entry] of this.taskPanes) {
      try {
        await this.options.tmux.killPane(entry.pane);
        this.taskPanes.delete(id);
      } catch (error) {
        if (await this.options.tmux.paneExists(entry.pane)) {
          errors.push(error);
        } else {
          this.taskPanes.delete(id);
        }
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Task pane cleanup incomplete");
    }
  }
}

export { TmuxTerminalDriver };
