import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock, ipcMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), ipcMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../../src/daemon/lifecycle.js", () => ({ socketPath: () => "/tmp/ownership.sock" }));
vi.mock("../../src/lib/ipc/client.js", () => ({ ipcRequest: ipcMock }));

const { execService } = await import("../../src/cli/exec-service.js");

function fixture() {
  const writes: string[] = [];
  const gate = new Duplex({
    read() {
      /* Test controls input. */
    },
    write(chunk: unknown, _encoding, done) {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
      done();
    },
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null,
    signalCode: null,
    stdio: [
      null,
      null,
      null,
      gate,
      new Duplex({
        read() {
          /* Keeper stays open. */
        },
        write(_chunk, _encoding, done) {
          done();
        },
      }),
    ],
    kill: vi.fn(),
  });
  spawnMock.mockReturnValue(child);
  return { child, gate, writes };
}

afterEach(() => vi.restoreAllMocks());

describe("wrapper ownership handshake", () => {
  it("blocks payload until ownership ACK and closes its control descriptor in the payload", async () => {
    const { child, gate, writes } = fixture();
    let acknowledge!: (value: { result: { ok: boolean } }) => void;
    ipcMock.mockImplementation(async (_socket: string, method: string) => {
      if (method === "exec-service.resolve") {
        return {
          result: { command: "node server.js", cwd: "/project", env: {}, trackOwnership: true },
        };
      }
      return new Promise<{ result: { ok: boolean } }>((resolve) => {
        acknowledge = resolve;
      });
    });
    const running = execService("web", "session", "id");
    await vi.waitFor(() =>
      expect(ipcMock).toHaveBeenCalledWith(
        "/tmp/ownership.sock",
        "exec-service.started",
        { service: "web", executionId: "id", pid: 42 },
        2000,
        "session",
      ),
    );
    expect(writes).toEqual([]);
    expect(spawnMock.mock.lastCall?.[1][1]).toContain("3<&- 4<&-");
    acknowledge({ result: { ok: true } });
    await vi.waitFor(() => expect(writes).toEqual(["start\n"]));
    gate.push("43\n");
    await vi.waitFor(() =>
      expect(ipcMock).toHaveBeenCalledWith(
        "/tmp/ownership.sock",
        "exec-service.started",
        { service: "web", executionId: "id", pid: 42, memberPid: 43 },
        2000,
        "session",
      ),
    );
    expect(writes).toEqual(["start\n"]);
    acknowledge({ result: { ok: true } });
    await running;
    expect(writes).toEqual(["start\n", "run\n"]);
    ipcMock.mockImplementation(
      async () =>
        new Promise<never>(() => {
          /* Keep exit pending. */
        }),
    );
    child.emit("exit", 0, null);
  });

  it("kills the blocked owned group after a failed ACK without releasing payload", async () => {
    const { writes } = fixture();
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    ipcMock.mockImplementation(async (_socket: string, method: string) => {
      if (method === "exec-service.resolve") {
        return {
          result: { command: "node server.js", cwd: "/project", env: {}, trackOwnership: true },
        };
      }
      if (method === "exec-service.started") {
        return { error: "stale launch" };
      }
      return new Promise<never>(() => {
        /* Keep exit pending. */
      });
    });
    await execService("web", "session", "stale");
    expect(writes).toEqual([]);
    expect(kill).toHaveBeenCalledExactlyOnceWith(-42, "SIGKILL");
  });
  it("does not release payload when keeper registration fails", async () => {
    const { child, gate, writes } = fixture();
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    let starts = 0;
    ipcMock.mockImplementation(async (_socket: string, method: string) => {
      if (method === "exec-service.resolve") {
        return {
          result: { command: "node server.js", cwd: "/project", env: {}, trackOwnership: true },
        };
      }
      if (method === "exec-service.started") {
        starts += 1;
        return starts === 1 ? { result: { ok: true } } : { error: "stale keeper" };
      }
      return new Promise<never>(() => {
        /* Keep exit pending. */
      });
    });
    const running = execService("web", "session", "stale");
    await vi.waitFor(() => expect(writes).toEqual(["start\n"]));
    gate.push("43\n");
    await running;
    expect(writes).toEqual(["start\n"]);
    expect(kill).toHaveBeenCalledExactlyOnceWith(-42, "SIGKILL");
    child.emit("exit", null, "SIGKILL");
  });
});
