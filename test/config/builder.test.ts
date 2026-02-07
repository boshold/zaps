import { describe, expect, it } from "vitest";

import { createZapsLib } from "../../src/config/builder.js";

describe("createZapsLib", () => {
  it("defineProject returns the same config", () => {
    const lib = createZapsLib();
    const cfg = {
      name: "test",
      services: {
        app: { start: "npm start" },
      },
    };

    expect(lib.defineProject(cfg)).toBe(cfg);
  });
});
