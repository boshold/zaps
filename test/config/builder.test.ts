import { describe, expect, it } from "vitest";

import { createZapsLib } from "../../src/config/builder.js";

describe("createZapsLib", () => {
  it("defineProject returns equivalent config", () => {
    const lib = createZapsLib();
    const cfg = {
      name: "test",
      services: {
        app: { start: "npm start" },
      },
    };

    expect(lib.defineProject(cfg)).toEqual(cfg);
  });

  it("throws readable error for invalid config", () => {
    const lib = createZapsLib();
    expect(() =>
      lib.defineProject({
        name: "test",
        services: {
          app: { start: 42 },
        },
      } as never),
    ).toThrow();
  });

  it("throws when service has no start/run/docker", () => {
    const lib = createZapsLib();
    expect(() =>
      lib.defineProject({
        name: "test",
        services: { api: {} },
      }),
    ).toThrow("Service 'api' must have 'start', 'run', or 'docker' config");
  });

  it("throws when services is empty", () => {
    const lib = createZapsLib();
    expect(() =>
      lib.defineProject({
        name: "test",
        services: {},
      }),
    ).toThrow("Project must have at least one service");
  });
});
