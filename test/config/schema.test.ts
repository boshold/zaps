import { describe, expect, it } from "vitest";

import { projectConfigSchema } from "../../src/config/schema.js";

describe("projectConfigSchema", () => {
  describe("services superRefine", () => {
    it("rejects empty services object", () => {
      const result = projectConfigSchema.safeParse({ services: {} });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message.includes("at least one service"))).toBe(
          true,
        );
      }
    });

    it("rejects service with no start/run/docker", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: {} },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) => i.message.includes("must have 'start', 'run', or")),
        ).toBe(true);
      }
    });

    it("accepts service with start", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("task superRefine", () => {
    it("rejects task with both commands and run", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        tasks: {
          build: {
            name: "Build",
            commands: "npm run build",
            run: async () => {},
          },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) => i.message.includes("either 'commands' or 'run', not")),
        ).toBe(true);
      }
    });

    it("rejects task with neither commands nor run", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        tasks: { build: { name: "Build" } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) => i.message.includes("must have either 'commands' or")),
        ).toBe(true);
      }
    });

    it("rejects task with popup + run", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        tasks: {
          build: {
            name: "Build",
            run: async () => {},
            popup: true,
          },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some((i) =>
            i.message.includes("'popup' can only be used with 'commands'"),
          ),
        ).toBe(true);
      }
    });
  });

  describe("layout", () => {
    it("accepts nested split layout", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        layout: {
          direction: "rows",
          children: [
            { pane: "api", size: "50%" },
            {
              direction: "columns",
              children: [
                { pane: "api", size: "50%" },
                { pane: "api" },
              ],
            },
          ],
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("z.custom validators", () => {
    it("accepts function commands", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: () => "npm dev" } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts readyFn (function)", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", ready: async () => true } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts readyOutput with function predicate", () => {
      const result = projectConfigSchema.safeParse({
        services: {
          api: { start: "npm dev", ready: { output: (line: string) => line.includes("ready") } },
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts readyPort with function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", ready: { port: () => 3000 } } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts env as function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", env: () => ({ NODE_ENV: "dev" }) } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts url as function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", url: () => "http://localhost:3000" } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts service hooks", () => {
      const result = projectConfigSchema.safeParse({
        services: {
          api: {
            start: "npm dev",
            onBeforeStart: async () => {},
            onReady: async () => {},
            onStop: async () => {},
            onOutput: async () => {},
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts task with run function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        tasks: { build: { name: "Build", run: async () => {} } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts project hooks", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        hooks: {
          onBeforeStart: async () => {},
          onStart: async () => {},
          onStop: async () => {},
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts cwd as function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        cwd: () => "/custom",
      });
      expect(result.success).toBe(true);
    });

    it("accepts docker config", () => {
      const result = projectConfigSchema.safeParse({
        services: {
          db: {
            docker: {
              service: ["postgres", "redis"],
              file: "docker-compose.yml",
              build: true,
              forceRecreate: true,
              renewVolumes: true,
              removeOrphans: true,
              pull: "always",
              noDeps: true,
            },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts task with function command in array", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        tasks: { build: { name: "Build", commands: [() => "npm run build", "npm test"] } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts task with popup object", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        tasks: {
          test: { name: "Test", commands: "npm test", popup: { width: "80%", height: "60%" } },
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts readyOutput with regex", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", ready: { output: /listening on/ } } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts readyDocker config", () => {
      const result = projectConfigSchema.safeParse({
        services: { db: { docker: { service: "postgres" }, ready: { docker: "postgres" } } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts readyHttp config", () => {
      const result = projectConfigSchema.safeParse({
        services: {
          api: { start: "npm dev", ready: { http: { url: "/health", status: 200 } } },
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts service with run command", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { run: "npm start" } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts full config with all features", () => {
      const result = projectConfigSchema.safeParse({
        name: "full-project",
        cwd: "/project",
        services: {
          db: {
            docker: { service: "postgres" },
            ready: { docker: ["postgres"], file: "docker-compose.yml" },
          },
          api: {
            start: "npm dev",
            stop: "npm stop",
            detached: true,
            dependsOn: ["db"],
            restartWith: ["db"],
            env: { PORT: "3000" },
            flags: { start: true, open: true },
            url: "http://localhost:3000",
            cwd: "/api",
            restart: { maxRetries: 3, backoff: 1000 },
            ready: { port: 3000 },
          },
        },
        tasks: {
          build: {
            name: "Build",
            commands: "npm run build",
            description: "Build project",
            cwd: "/build",
            dependsOn: ["lint"],
            env: { NODE_ENV: "production" },
            shortcut: "b",
          },
          lint: { name: "Lint", commands: ["eslint .", "prettier --check ."] },
        },
        layout: { pane: "api", size: "100%", focus: true },
        hooks: { onStart: () => {} },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("z.custom validator rejections", () => {
    it("rejects commandSchema with number", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: 42 } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects readyFn with non-function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", ready: "not-a-function" } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects readyOutput with non-regex non-function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", ready: { output: 123 } } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects readyPort with non-number non-function non-true", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", ready: { port: "not-valid" } } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects cwdConfigSchema with invalid type", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        cwd: 123,
      });
      expect(result.success).toBe(false);
    });

    it("rejects taskRunFnSchema with non-function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        tasks: { build: { name: "Build", run: "not-a-function" } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects onBeforeStart with non-function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", onBeforeStart: "bad" } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects onReady with non-function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", onReady: 42 } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects onStop with non-function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", onStop: true } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects onOutput with non-function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", onOutput: [] } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects project hooks.onBeforeStart with non-function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        hooks: { onBeforeStart: "bad" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects project hooks.onStart with non-function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        hooks: { onStart: 42 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects project hooks.onStop with non-function", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev" } },
        hooks: { onStop: "bad" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects env with invalid type", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", env: 42 } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects url with invalid type", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", url: 42 } },
      });
      expect(result.success).toBe(false);
    });

    it("accepts readyDocker with array of strings", () => {
      const result = projectConfigSchema.safeParse({
        services: {
          db: { docker: { service: "postgres" }, ready: { docker: ["svc1", "svc2"] } },
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts readyHttp with string shorthand", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", ready: { http: "/health" } } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts readyPort with true literal", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", ready: { port: true } } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts url as false", () => {
      const result = projectConfigSchema.safeParse({
        services: { api: { start: "npm dev", url: false } },
      });
      expect(result.success).toBe(true);
    });
  });
});
