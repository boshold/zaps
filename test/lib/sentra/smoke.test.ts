import { describe, expect, it } from "vitest";

import { runSentraSmoke } from "#src/lib/sentra/smoke.js";

describe("runSentraSmoke", () => {
  it("opens SQLite storage with the node:sqlite driver", async () => {
    await expect(runSentraSmoke()).resolves.toBe("node");
  });
});
