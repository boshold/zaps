import type { ReadyConfig, ReadyDeps } from "../../../src/lib/service/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForReady } from "../../../src/lib/service/ready.js";

const mockDetectPorts = vi.fn<ReadyDeps["detectPorts"]>();
const mockCapturePane = vi.fn<ReadyDeps["capturePane"]>();

function createDeps(): ReadyDeps {
  return {
    detectPorts: mockDetectPorts,
    capturePane: mockCapturePane,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForReady", () => {
  it("resolves immediately when config is undefined", async () => {
    const controller = new AbortController();
    await waitForReady(undefined, "%0", controller.signal, createDeps());
    // No assertions needed -- just checking it resolves
  });

  it("resolves on port mode when port is detected on 3rd call", async () => {
    let callCount = 0;
    mockDetectPorts.mockImplementation(async () => {
      callCount += 1;
      if (callCount >= 3) {
        return [3000];
      }
      return [];
    });

    const controller = new AbortController();
    const config: ReadyConfig = { port: 3000 };

    const promise = waitForReady(config, "%0", controller.signal, createDeps());

    // Advance through poll intervals
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    await promise;
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("throws timeout error on port mode when port never appears", async () => {
    mockDetectPorts.mockResolvedValue([]);

    const controller = new AbortController();
    const config: ReadyConfig = { port: 9999 };

    const promise = waitForReady(config, "%0", controller.signal, createDeps());

    // Consume rejection to prevent unhandled rejection during timer advancement
    const guarded = promise.catch(() => {
      /* Intentional no-op */
    });

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(61_000);
    await guarded;

    await expect(promise).rejects.toThrow("Ready check timed out after 60s");
  });

  it("resolves on output mode (regex) when match found on 2nd call", async () => {
    let callCount = 0;
    mockCapturePane.mockImplementation(async () => {
      callCount += 1;
      if (callCount >= 2) {
        return "some log\nready on port 3000\nmore logs";
      }
      return "starting up...";
    });

    const controller = new AbortController();
    const config: ReadyConfig = { output: /ready on/ };

    const promise = waitForReady(config, "%0", controller.signal, createDeps());

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    await promise;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("resolves on output mode (function) when fn returns true", async () => {
    let callCount = 0;
    mockCapturePane.mockImplementation(async () => {
      callCount += 1;
      if (callCount >= 2) {
        return "server started";
      }
      return "booting...";
    });

    const controller = new AbortController();
    const config: ReadyConfig = { output: (line: string) => line.includes("server started") };

    const promise = waitForReady(config, "%0", controller.signal, createDeps());

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    await promise;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("resolves on function mode when fn returns true on 2nd call", async () => {
    let callCount = 0;
    const checkFn: ReadyConfig = async () => {
      callCount += 1;
      return callCount >= 2;
    };

    const controller = new AbortController();

    const promise = waitForReady(checkFn, "%0", controller.signal, createDeps());

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    await promise;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("throws abort error when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const config: ReadyConfig = { port: 3000 };
    await expect(waitForReady(config, "%0", controller.signal, createDeps())).rejects.toThrow(
      "Ready check aborted",
    );
  });

  it("handles port as function", async () => {
    mockDetectPorts.mockResolvedValue([5432]);

    const controller = new AbortController();
    const config: ReadyConfig = { port: () => 5432 };

    const promise = waitForReady(config, "%0", controller.signal, createDeps());

    await vi.advanceTimersByTimeAsync(500);

    await promise;
    expect(mockDetectPorts).toHaveBeenCalled();
  });

  it("polls at ~500ms intervals", async () => {
    let callCount = 0;
    mockDetectPorts.mockImplementation(async () => {
      callCount += 1;
      if (callCount >= 4) {
        return [3000];
      }
      return [];
    });

    const controller = new AbortController();
    const config: ReadyConfig = { port: 3000 };

    const promise = waitForReady(config, "%0", controller.signal, createDeps());

    // After 1 interval, should have called at least once more
    await vi.advanceTimersByTimeAsync(500);
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Advance enough to resolve
    await vi.advanceTimersByTimeAsync(1500);

    await promise;
    expect(callCount).toBeGreaterThanOrEqual(4);
  });
});
