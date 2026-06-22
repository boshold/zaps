import { describe, expect, it } from "vitest";

import { TaskOutputStore } from "../../src/daemon/task-output-store.js";

function makeStore(maxRuns = 20, lineCap = 5000): TaskOutputStore {
  return new TaskOutputStore({ maxRuns, lineCap });
}

describe("TaskOutputStore", () => {
  describe("append + snapshot", () => {
    it("retains a run's metadata and lines", () => {
      const store = makeStore();
      store.start("run_1", "migrate", 1000);
      store.append("run_1", "applying migration 001");
      store.appendLines("run_1", ["applying migration 002", "done"]);
      store.finish("run_1", "success", 2000);

      const snap = store.get("run_1");
      expect(snap).toEqual({
        runId: "run_1",
        taskKey: "migrate",
        result: "success",
        lines: ["applying migration 001", "applying migration 002", "done"],
        startedAt: 1000,
        endedAt: 2000,
      });
    });

    it("reports a still-running run with no endedAt", () => {
      const store = makeStore();
      store.start("run_1", "build", 500);
      store.append("run_1", "compiling");

      const snap = store.get("run_1");
      expect(snap?.result).toBe("running");
      expect(snap?.endedAt).toBeUndefined();
      expect(snap?.lines).toEqual(["compiling"]);
    });

    it("ignores appends/finish for an unknown run", () => {
      const store = makeStore();
      // None of these throw.
      store.append("nope", "x");
      store.appendLines("nope", ["y"]);
      store.finish("nope", "error", 1);
      expect(store.get("nope")).toBeNull();
    });

    it("bounds each buffer to the line cap (oldest lines drop)", () => {
      const store = makeStore(20, 3);
      store.start("run_1", "spam", 0);
      store.appendLines("run_1", ["a", "b", "c", "d", "e"]);
      expect(store.get("run_1")?.lines).toEqual(["c", "d", "e"]);
    });
  });

  describe("not_found", () => {
    it("returns null for an unknown runId", () => {
      const store = makeStore();
      expect(store.get("never")).toBeNull();
    });

    it("returns null after a run is evicted", () => {
      const store = makeStore(2);
      store.start("run_1", "t", 1);
      store.finish("run_1", "success", 2);
      store.start("run_2", "t", 3);
      store.finish("run_2", "success", 4);
      store.start("run_3", "t", 5); // Over cap → evict oldest success (run_1).
      expect(store.get("run_1")).toBeNull();
      expect(store.get("run_2")).not.toBeNull();
      expect(store.get("run_3")).not.toBeNull();
    });
  });

  describe("eviction (failure-preferential)", () => {
    it("evicts the oldest success while keeping failures", () => {
      const store = makeStore(3);
      store.start("ok_1", "t", 1);
      store.finish("ok_1", "success", 2);
      store.start("fail_1", "t", 3);
      store.finish("fail_1", "error", 4);
      store.start("ok_2", "t", 5);
      store.finish("ok_2", "success", 6);

      // 4th run pushes over cap (3): oldest NON-error (ok_1) is evicted, not the failure.
      store.start("ok_3", "t", 7);
      store.finish("ok_3", "success", 8);

      expect(store.get("ok_1")).toBeNull();
      expect(store.get("fail_1")).not.toBeNull();
      expect(store.get("ok_2")).not.toBeNull();
      expect(store.get("ok_3")).not.toBeNull();
      expect(store.size).toBe(3);
    });

    it("keeps newer failures over older ones, evicting failures only when nothing else remains", () => {
      const store = makeStore(2);
      store.start("fail_1", "t", 1);
      store.finish("fail_1", "error", 2);
      store.start("fail_2", "t", 3);
      store.finish("fail_2", "error", 4);

      // All retained are failures; over cap → oldest failure (fail_1) is evicted.
      store.start("fail_3", "t", 5);
      store.finish("fail_3", "error", 6);

      expect(store.get("fail_1")).toBeNull();
      expect(store.get("fail_2")).not.toBeNull();
      expect(store.get("fail_3")).not.toBeNull();
      expect(store.size).toBe(2);
    });

    it("keeps an in-flight (running) run, evicting an older settled success instead", () => {
      const store = makeStore(2);
      store.start("ok_1", "t", 1);
      store.finish("ok_1", "success", 2);
      store.start("run_2", "t", 3); // Stays running (in-flight, actively streaming).

      store.start("run_3", "t", 4); // Over cap → drop oldest settled success (ok_1).
      expect(store.get("ok_1")).toBeNull();
      expect(store.get("run_2")).not.toBeNull();
      expect(store.get("run_3")).not.toBeNull();
    });

    it("only evicts a running run when every retained run is in-flight", () => {
      const store = makeStore(2);
      store.start("run_1", "t", 1); // Running.
      store.start("run_2", "t", 2); // Running.
      store.start("run_3", "t", 3); // Over cap, all running → drop the oldest (run_1).
      expect(store.get("run_1")).toBeNull();
      expect(store.get("run_2")).not.toBeNull();
      expect(store.get("run_3")).not.toBeNull();
    });

    it("re-using a runId resets the buffer and refreshes its eviction order", () => {
      const store = makeStore(2);
      store.start("a", "t", 1);
      store.finish("a", "success", 2);
      store.start("b", "t", 3);
      store.finish("b", "success", 4);

      // Re-start "a": it becomes the NEWEST, so the next overflow evicts "b".
      store.start("a", "t", 5);
      store.append("a", "fresh");
      store.start("c", "t", 6);

      expect(store.get("a")?.lines).toEqual(["fresh"]);
      expect(store.get("b")).toBeNull();
      expect(store.get("c")).not.toBeNull();
    });
  });
});
