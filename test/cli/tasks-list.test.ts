import { describe, expect, it, vi } from "vitest";

import { CliError } from "#src/cli/helpers.js";
import type { SessionIpc } from "#src/cli/helpers.js";
import { listTasks } from "#src/cli/tasks-list.js";
import type { TaskConfig } from "#src/config/types.js";
import type { IpcResponse } from "#src/lib/ipc/protocol.js";
import { buildTaskListEntries } from "#src/lib/task/list-entry.js";

const tasks: Record<string, TaskConfig> = {
  migrate: { name: "Migrate", commands: "m", services: ["db"], autoStart: true },
  seed: { name: "Seed", commands: "s", dependsOn: ["migrate"] },
};

function deps(lookup: (sessionArg?: string) => IpcResponse | Error) {
  return {
    withDaemon: vi.fn(
      async (
        fn: (ipc: Pick<SessionIpc, "request">) => Promise<unknown>,
        sessionArg?: string,
      ): Promise<unknown> => {
        const outcome = lookup(sessionArg);
        if (outcome instanceof Error) {
          throw outcome;
        }
        return fn({ request: async () => outcome });
      },
    ),
    loadLocalTasks: vi.fn(async () => tasks),
  };
}

describe("listTasks", () => {
  it("uses the session when one runs", async () => {
    const d = deps(() => ({ id: "t", result: ["from-session"] }));
    await expect(listTasks(undefined, d)).resolves.toEqual(["from-session"]);
    expect(d.loadLocalTasks).not.toHaveBeenCalled();
  });

  it.each(["No running zaps session for this project.", "Daemon not running."])(
    "reads the local config when: %s",
    async (message) => {
      const d = deps(() => new CliError(message));
      await expect(listTasks(undefined, d)).resolves.toEqual(buildTaskListEntries(tasks));
    },
  );

  it("keeps requiring the session given with -s", async () => {
    const d = deps((sessionArg) =>
      sessionArg === "abc"
        ? new CliError("No running zaps session for this project.")
        : new Error("unexpected lookup"),
    );
    await expect(listTasks("abc", d)).rejects.toThrow("No running zaps session");
    expect(d.loadLocalTasks).not.toHaveBeenCalled();
  });

  it("rethrows other errors", async () => {
    const d = deps(() => new CliError("Cannot access zaps daemon socket (EPERM)."));
    await expect(listTasks(undefined, d)).rejects.toThrow("EPERM");
    expect(d.loadLocalTasks).not.toHaveBeenCalled();
  });

  it("reports tasks.list errors", async () => {
    const d = deps(() => ({ id: "t", error: "boom" }));
    await expect(listTasks(undefined, d)).rejects.toThrow("Error: boom");
  });
});
