import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForReady } from "../../../src/lib/service/ready.js";
import type { ReadyConfig, ReadyDeps } from "../../../src/lib/service/types.js";

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
  it("resolves immediately when config is undefined and returns empty ports", async () => {
    const controller = new AbortController();
    const ports = await waitForReady(undefined, "%0", controller.signal, createDeps());
    expect(ports).toEqual([]);
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

  it("resolves on port: true when any port is detected", async () => {
    let callCount = 0;
    mockDetectPorts.mockImplementation(async () => {
      callCount += 1;
      if (callCount >= 2) {
        return [54_321];
      }
      return [];
    });

    const controller = new AbortController();
    const config: ReadyConfig = { port: true };

    const promise = waitForReady(config, "%0", controller.signal, createDeps());

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    await promise;
    expect(callCount).toBeGreaterThanOrEqual(2);
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

  it("returns silently when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const config: ReadyConfig = { port: 3000 };
    await expect(waitForReady(config, "%0", controller.signal, createDeps())).resolves.toEqual([]);
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

  it("resolves docker mode and returns ports when container is ready", async () => {
    const mockDockerStatus = vi.fn<NonNullable<ReadyDeps["dockerStatus"]>>();
    let callCount = 0;
    mockDockerStatus.mockImplementation(async () => {
      callCount += 1;
      if (callCount >= 2) {
        return { state: "running", health: "healthy", ports: [5432] };
      }
      return { state: "created", health: "", ports: [] };
    });

    const controller = new AbortController();
    const config: ReadyConfig = { docker: "postgres" };
    const deps: ReadyDeps = {
      ...createDeps(),
      cwd: "/project",
      dockerStatus: mockDockerStatus,
    };

    const promise = waitForReady(config, "%0", controller.signal, deps);

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    const ports = await promise;
    expect(ports).toEqual([5432]);
    expect(mockDockerStatus).toHaveBeenCalledWith("postgres", "/project", undefined);
  });

  it("resolves docker mode with no healthcheck (empty health)", async () => {
    const mockDockerStatus = vi.fn<NonNullable<ReadyDeps["dockerStatus"]>>();
    mockDockerStatus.mockResolvedValue({ state: "running", health: "", ports: [3306] });

    const controller = new AbortController();
    const config: ReadyConfig = { docker: "mysql" };
    const deps: ReadyDeps = {
      ...createDeps(),
      dockerStatus: mockDockerStatus,
    };

    const promise = waitForReady(config, "%0", controller.signal, deps);
    await vi.advanceTimersByTimeAsync(500);

    const ports = await promise;
    expect(ports).toEqual([3306]);
  });

  it("times out docker mode when container never becomes ready", async () => {
    const mockDockerStatus = vi.fn<NonNullable<ReadyDeps["dockerStatus"]>>();
    mockDockerStatus.mockResolvedValue({ state: "running", health: "starting", ports: [] });

    const controller = new AbortController();
    const config: ReadyConfig = { docker: "postgres" };
    const deps: ReadyDeps = {
      ...createDeps(),
      dockerStatus: mockDockerStatus,
    };

    const promise = waitForReady(config, "%0", controller.signal, deps);
    const guarded = promise.catch(() => {
      /* Intentional no-op */
    });

    await vi.advanceTimersByTimeAsync(61_000);
    await guarded;

    await expect(promise).rejects.toThrow("Ready check timed out after 60s");
  });

  it("returns silently when docker mode signal is already aborted", async () => {
    const mockDockerStatus = vi.fn<NonNullable<ReadyDeps["dockerStatus"]>>();
    mockDockerStatus.mockResolvedValue(null);

    const controller = new AbortController();
    controller.abort();

    const config: ReadyConfig = { docker: "postgres" };
    const deps: ReadyDeps = {
      ...createDeps(),
      dockerStatus: mockDockerStatus,
    };

    await expect(waitForReady(config, "%0", controller.signal, deps)).resolves.toEqual([]);
  });

  it("passes config.file to dockerStatus", async () => {
    const mockDockerStatus = vi.fn<NonNullable<ReadyDeps["dockerStatus"]>>();
    mockDockerStatus.mockResolvedValue({ state: "running", health: "", ports: [5432] });

    const controller = new AbortController();
    const config: ReadyConfig = { docker: "postgres", file: "custom.yml" };
    const deps: ReadyDeps = {
      ...createDeps(),
      cwd: "/project",
      dockerStatus: mockDockerStatus,
    };

    const promise = waitForReady(config, "%0", controller.signal, deps);
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(mockDockerStatus).toHaveBeenCalledWith("postgres", "/project", "custom.yml");
  });

  it("falls back to deps.composeFile when config.file is unset", async () => {
    const mockDockerStatus = vi.fn<NonNullable<ReadyDeps["dockerStatus"]>>();
    mockDockerStatus.mockResolvedValue({ state: "running", health: "", ports: [5432] });

    const controller = new AbortController();
    const config: ReadyConfig = { docker: "postgres" };
    const deps: ReadyDeps = {
      ...createDeps(),
      cwd: "/project",
      composeFile: "fallback.yml",
      dockerStatus: mockDockerStatus,
    };

    const promise = waitForReady(config, "%0", controller.signal, deps);
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(mockDockerStatus).toHaveBeenCalledWith("postgres", "/project", "fallback.yml");
  });

  it("config.file takes precedence over deps.composeFile", async () => {
    const mockDockerStatus = vi.fn<NonNullable<ReadyDeps["dockerStatus"]>>();
    mockDockerStatus.mockResolvedValue({ state: "running", health: "", ports: [5432] });

    const controller = new AbortController();
    const config: ReadyConfig = { docker: "postgres", file: "override.yml" };
    const deps: ReadyDeps = {
      ...createDeps(),
      composeFile: "fallback.yml",
      dockerStatus: mockDockerStatus,
    };

    const promise = waitForReady(config, "%0", controller.signal, deps);
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(mockDockerStatus).toHaveBeenCalledWith("postgres", undefined, "override.yml");
  });

  it("throws when dockerStatus dep is missing for docker mode", async () => {
    const controller = new AbortController();
    const config: ReadyConfig = { docker: "postgres" };

    await expect(waitForReady(config, "%0", controller.signal, createDeps())).rejects.toThrow(
      "Docker status dependency not provided",
    );
  });

  describe("http mode", () => {
    const mockFetch = vi.fn<typeof globalThis.fetch>();

    beforeEach(() => {
      vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("path mode: waits for port then probes endpoint", async () => {
      let portCalls = 0;
      mockDetectPorts.mockImplementation(async () => {
        portCalls += 1;
        return portCalls >= 2 ? [3000] : [];
      });

      let fetchCalls = 0;
      mockFetch.mockImplementation(async () => {
        fetchCalls += 1;
        if (fetchCalls >= 2) {
          return new Response("ok", { status: 200 });
        }
        throw new Error("ECONNREFUSED");
      });

      const controller = new AbortController();
      const config: ReadyConfig = { http: "/health" };

      const promise = waitForReady(config, "%0", controller.signal, createDeps());

      // Port detection phase
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);
      // HTTP probing phase
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      const ports = await promise;
      expect(ports).toEqual([]);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/health",
        expect.objectContaining({ method: "GET", redirect: "manual" }),
      );
    });

    it("full URL mode: probes directly without port detection", async () => {
      mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));

      const controller = new AbortController();
      const config: ReadyConfig = { http: "http://localhost:4000/health" };

      const promise = waitForReady(config, "%0", controller.signal, createDeps());
      await vi.advanceTimersByTimeAsync(500);

      const ports = await promise;
      expect(ports).toEqual([]);
      expect(mockDetectPorts).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4000/health",
        expect.objectContaining({ method: "GET", redirect: "manual" }),
      );
    });

    it("status check: succeeds only when status matches", async () => {
      let fetchCalls = 0;
      mockFetch.mockImplementation(async () => {
        fetchCalls += 1;
        if (fetchCalls >= 3) {
          return new Response("ok", { status: 200 });
        }
        return new Response("not ready", { status: 503 });
      });

      const controller = new AbortController();
      const config: ReadyConfig = { http: { url: "http://localhost:3000/health", status: 200 } };

      const promise = waitForReady(config, "%0", controller.signal, createDeps());

      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      await promise;
      expect(fetchCalls).toBeGreaterThanOrEqual(3);
    });

    it("without status: any response counts as ready", async () => {
      mockFetch.mockResolvedValue(new Response("error", { status: 500 }));

      const controller = new AbortController();
      const config: ReadyConfig = { http: "http://localhost:3000/health" };

      const promise = waitForReady(config, "%0", controller.signal, createDeps());
      await vi.advanceTimersByTimeAsync(500);

      await promise;
    });

    it("times out when endpoint never responds", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const controller = new AbortController();
      const config: ReadyConfig = { http: "http://localhost:3000/health" };

      const promise = waitForReady(config, "%0", controller.signal, createDeps());
      const guarded = promise.catch(() => {
        /* Intentional no-op */
      });

      await vi.advanceTimersByTimeAsync(61_000);
      await guarded;

      await expect(promise).rejects.toThrow("Ready check timed out after 60s");
    });

    it("returns silently when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const config: ReadyConfig = { http: "http://localhost:3000/health" };

      await expect(waitForReady(config, "%0", controller.signal, createDeps())).resolves.toEqual(
        [],
      );
    });

    it("object form with path uses port detection", async () => {
      mockDetectPorts.mockResolvedValue([8080]);
      mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));

      const controller = new AbortController();
      const config: ReadyConfig = { http: { url: "/api/health", status: 200 } };

      const promise = waitForReady(config, "%0", controller.signal, createDeps());
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      await promise;
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/api/health",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  it("existing modes return empty ports array", async () => {
    mockDetectPorts.mockResolvedValue([3000]);

    const controller = new AbortController();
    const config: ReadyConfig = { port: 3000 };

    const promise = waitForReady(config, "%0", controller.signal, createDeps());
    await vi.advanceTimersByTimeAsync(500);

    const ports = await promise;
    expect(ports).toEqual([]);
  });

  it("docker mode with string[] checks all services and dedupes ports", async () => {
    const mockDockerStatus = vi.fn<NonNullable<ReadyDeps["dockerStatus"]>>();
    mockDockerStatus.mockImplementation(async (svc: string) => {
      if (svc === "postgres") {
        return { state: "running", health: "", ports: [5432] };
      }
      if (svc === "redis") {
        return { state: "running", health: "", ports: [6379, 5432] };
      }
      return null;
    });

    const controller = new AbortController();
    const config: ReadyConfig = { docker: ["postgres", "redis"] };
    const deps: ReadyDeps = {
      ...createDeps(),
      dockerStatus: mockDockerStatus,
    };

    const promise = waitForReady(config, "%0", controller.signal, deps);
    await vi.advanceTimersByTimeAsync(500);

    const ports = await promise;
    expect(ports).toEqual([5432, 6379]);
    expect(mockDockerStatus).toHaveBeenCalledWith("postgres", undefined, undefined);
    expect(mockDockerStatus).toHaveBeenCalledWith("redis", undefined, undefined);
  });

  it("docker mode with string[] returns false if one service not ready", async () => {
    const mockDockerStatus = vi.fn<NonNullable<ReadyDeps["dockerStatus"]>>();
    let callCount = 0;
    mockDockerStatus.mockImplementation(async (svc: string) => {
      callCount += 1;
      if (svc === "postgres") {
        return { state: "running", health: "", ports: [5432] };
      }
      // Redis never ready
      return { state: "created", health: "", ports: [] };
    });

    const controller = new AbortController();
    const config: ReadyConfig = { docker: ["postgres", "redis"] };
    const deps: ReadyDeps = {
      ...createDeps(),
      dockerStatus: mockDockerStatus,
    };

    const promise = waitForReady(config, "%0", controller.signal, deps);
    const guarded = promise.catch(() => {
      /* Intentional no-op */
    });

    await vi.advanceTimersByTimeAsync(61_000);
    await guarded;

    await expect(promise).rejects.toThrow("Ready check timed out after 60s");
  });
});
