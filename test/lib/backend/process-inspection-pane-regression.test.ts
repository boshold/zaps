import { expect, it } from "vitest";

import { createProcessInspection } from "#src/lib/backend/runtime/process-inspection.js";

it.each([100, 90])("discovers pane orphans only when its PID owns group %s", async (pgid) => {
  const groups = new Map([
    [100, pgid],
    [101, 100],
    [102, 102],
    [200, 200],
    [201, 200],
    [300, 300],
  ]);
  const sessions = new Map([
    [100, 80],
    [101, 80],
    [102, 80],
    [200, 200],
    [201, 200],
    [300, 300],
  ]);
  const inspection = createProcessInspection({
    platform: "linux",
    exec: async () =>
      "PID PPID SID\n100 1 80\n101 1 80\n102 1 80\n200 100 200\n201 1 200\n300 1 300",
    readProc: async (file) => {
      if (!file.endsWith("/stat")) {
        return "node\0server\0";
      }
      const pid = Number(file.split("/")[2]);
      return `${String(pid)} (node) S 1 ${String(groups.get(pid))} ${String(sessions.get(pid))} ${Array.from({ length: 15 }, () => "0").join(" ")} 1000 0`;
    },
  });
  const descendants = await inspection.getDescendantPids(100);
  expect(descendants).toContain(200);
  expect(descendants).toContain(201);
  expect(descendants.includes(101)).toBe(pgid === 100);
  expect(descendants).not.toContain(102);
  expect(descendants).not.toContain(300);
});
