import type { LayoutNode, ProjectConfig, ReadyConfig } from "../../src/config/types.js";
import { describe, expect, it } from "vitest";

import { isLayoutLeaf, isLayoutSplit, isReadyOutput, isReadyPort } from "../../src/config/types.js";

const readyFn: ReadyConfig = async () => true;

describe("config types", () => {
  it("creates a valid ProjectConfig", () => {
    const config: ProjectConfig = {
      name: "my-project",
      services: {
        db: {
          start: "docker compose up postgres",
          ready: { port: 5432 },
        },
        api: {
          start: "pnpm dev:api",
          dependsOn: ["db"],
          env: (ctx) => ({ DB_PORT: String(ctx.services.db.port) }),
        },
        frontend: {
          start: "pnpm dev:web",
          dependsOn: ["api"],
          ready: { output: /ready on/ },
        },
        worker: {
          start: "pnpm worker",
          detached: true,
        },
      },
      tasks: {
        migrate: {
          name: "Run migrations",
          commands: "pnpm db:migrate",
          dependsOn: ["seed"],
        },
        seed: {
          name: "Seed DB",
          commands: "pnpm db:seed",
        },
      },
      layout: {
        direction: "columns",
        children: [
          { pane: "@tui", size: "30%" },
          {
            direction: "rows",
            children: [
              { pane: "api", size: "50%" },
              { pane: "frontend", size: "50%" },
            ],
          },
        ],
      },
      hooks: {
        onStart: () => {
          /* Noop */
        },
        onStop: () => {
          /* Noop */
        },
      },
    };

    expect(config.name).toBe("my-project");
    expect(Object.keys(config.services)).toHaveLength(4);
    expect(config.tasks?.migrate.dependsOn).toEqual(["seed"]);
  });

  it("allows ServiceConfig with run alias", () => {
    const config: ProjectConfig = {
      name: "test",
      services: {
        app: { run: "npm start", autostart: false },
      },
    };
    expect(config.services.app.run).toBe("npm start");
  });

  it("allows Command as function", () => {
    const config: ProjectConfig = {
      name: "test",
      services: {
        app: { start: () => "npm start" },
      },
    };
    const cmd = config.services.app.start;
    expect(typeof cmd).toBe("function");
    if (typeof cmd === "function") {
      expect(cmd()).toBe("npm start");
    }
  });

  it("allows restart config", () => {
    const config: ProjectConfig = {
      name: "test",
      services: {
        app: { start: "npm start", restart: { maxRetries: 5, backoff: 1000 } },
      },
    };
    expect(config.services.app.restart?.maxRetries).toBe(5);
  });

  it("allows url as string or function", () => {
    const config: ProjectConfig = {
      name: "test",
      services: {
        web: { start: "npm start", url: "http://localhost:3000" },
        api: {
          start: "npm start",
          url: (ctx) => `http://localhost:${ctx.services.api.port}`,
        },
      },
    };
    expect(config.services.web.url).toBe("http://localhost:3000");
    expect(typeof config.services.api.url).toBe("function");
  });
});

describe("type guards", () => {
  describe("isLayoutLeaf", () => {
    it("returns true for leaf nodes", () => {
      const leaf: LayoutNode = { pane: "api", size: "50%" };
      expect(isLayoutLeaf(leaf)).toBe(true);
    });

    it("returns false for split nodes", () => {
      const split: LayoutNode = {
        direction: "rows",
        children: [{ pane: "a" }],
      };
      expect(isLayoutLeaf(split)).toBe(false);
    });
  });

  describe("isLayoutSplit", () => {
    it("returns true for split nodes", () => {
      const split: LayoutNode = {
        direction: "columns",
        children: [{ pane: "a" }, { pane: "b" }],
      };
      expect(isLayoutSplit(split)).toBe(true);
    });

    it("returns false for leaf nodes", () => {
      const leaf: LayoutNode = { pane: "api" };
      expect(isLayoutSplit(leaf)).toBe(false);
    });
  });

  describe("isReadyPort", () => {
    it("returns true for port config", () => {
      const ready: ReadyConfig = { port: 3000 };
      expect(isReadyPort(ready)).toBe(true);
    });

    it("returns true for port config with function", () => {
      const ready: ReadyConfig = { port: () => 3000 };
      expect(isReadyPort(ready)).toBe(true);
    });

    it("returns true for port config with true (any-port)", () => {
      const ready: ReadyConfig = { port: true };
      expect(isReadyPort(ready)).toBe(true);
    });

    it("returns false for output config", () => {
      const ready: ReadyConfig = { output: /ready/ };
      expect(isReadyPort(ready)).toBe(false);
    });

    it("returns false for function config", () => {
      expect(isReadyPort(readyFn)).toBe(false);
    });
  });

  describe("isReadyOutput", () => {
    it("returns true for output config with regex", () => {
      const ready: ReadyConfig = { output: /listening/ };
      expect(isReadyOutput(ready)).toBe(true);
    });

    it("returns true for output config with function", () => {
      const ready: ReadyConfig = {
        output: (line: string) => line.includes("ready"),
      };
      expect(isReadyOutput(ready)).toBe(true);
    });

    it("returns false for port config", () => {
      const ready: ReadyConfig = { port: 8080 };
      expect(isReadyOutput(ready)).toBe(false);
    });

    it("returns false for function config", () => {
      expect(isReadyOutput(readyFn)).toBe(false);
    });
  });
});
