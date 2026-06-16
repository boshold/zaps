import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildDockerCommand,
  composeProjectArgs,
  isReady,
  legacyProjectWarning,
  parseContainerInfo,
  sanitizeProjectName,
} from "../../src/lib/docker.js";

describe("parseContainerInfo", () => {
  it("parses a single JSON object", () => {
    const json = JSON.stringify({
      State: "running",
      Health: "healthy",
      Publishers: [{ PublishedPort: 5432 }, { PublishedPort: 8080 }],
    });
    expect(parseContainerInfo(json)).toEqual({
      state: "running",
      health: "healthy",
      ports: [5432, 8080],
      ids: [],
    });
  });

  it("parses a single-record JSON array", () => {
    const json = JSON.stringify([
      { State: "running", Health: "", Publishers: [{ PublishedPort: 3000 }] },
    ]);
    expect(parseContainerInfo(json)).toEqual({
      state: "running",
      health: "",
      ports: [3000],
      ids: [],
    });
  });

  it("aggregates a multi-record array: ready iff all ready, ports merged", () => {
    const json = JSON.stringify([
      { State: "running", Health: "healthy", Publishers: [{ PublishedPort: 5432 }] },
      { State: "running", Health: "healthy", Publishers: [{ PublishedPort: 5433 }] },
    ]);
    expect(parseContainerInfo(json)).toEqual({
      state: "running",
      health: "healthy",
      ports: [5432, 5433],
      ids: [],
    });
  });

  it("propagates an exited record from JSONL and merges ports (B6)", () => {
    const line1 = JSON.stringify({
      State: "running",
      Health: "healthy",
      Publishers: [{ PublishedPort: 5432 }],
    });
    const line2 = JSON.stringify({
      State: "exited",
      Health: "",
      Publishers: [{ PublishedPort: 5433 }],
    });
    expect(parseContainerInfo(`${line1}\n${line2}`)).toEqual({
      state: "exited",
      health: "",
      ports: [5432, 5433],
      ids: [],
    });
  });

  it("merges, dedups, and sorts container ids across records (B4)", () => {
    const line1 = JSON.stringify({ ID: "b2", State: "running", Health: "", Publishers: [] });
    const line2 = JSON.stringify({ ID: "a1", State: "running", Health: "", Publishers: [] });
    const line3 = JSON.stringify({ ID: "a1", State: "running", Health: "", Publishers: [] });
    expect(parseContainerInfo(`${line1}\n${line2}\n${line3}`)?.ids).toEqual(["a1", "b2"]);
  });

  it("falls back to Name when ID is absent", () => {
    const json = JSON.stringify({
      Name: "proj-db-1",
      State: "running",
      Health: "",
      Publishers: [],
    });
    expect(parseContainerInfo(json)?.ids).toEqual(["proj-db-1"]);
  });

  it("parses a bare single object (compose v2.21 single container)", () => {
    const json = JSON.stringify({
      State: "running",
      Health: "",
      Publishers: [{ PublishedPort: 80 }],
    });
    expect(parseContainerInfo(json)).toEqual({
      state: "running",
      health: "",
      ports: [80],
      ids: [],
    });
  });

  it("returns null for empty output", () => {
    expect(parseContainerInfo("")).toBeNull();
    expect(parseContainerInfo("  \n  ")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseContainerInfo("not json at all")).toBeNull();
  });

  it("returns null for empty JSON array", () => {
    expect(parseContainerInfo("[]")).toBeNull();
  });

  it("handles missing Publishers field", () => {
    expect(parseContainerInfo(JSON.stringify({ State: "running", Health: "" }))).toEqual({
      state: "running",
      health: "",
      ports: [],
      ids: [],
    });
  });

  it("filters out zero and negative ports", () => {
    const json = JSON.stringify({
      State: "running",
      Health: "",
      Publishers: [{ PublishedPort: 0 }, { PublishedPort: -1 }, { PublishedPort: 5432 }],
    });
    expect(parseContainerInfo(json)?.ports).toEqual([5432]);
  });

  it("deduplicates and sorts merged ports", () => {
    const line1 = JSON.stringify({
      State: "running",
      Health: "",
      Publishers: [{ PublishedPort: 8080 }],
    });
    const line2 = JSON.stringify({
      State: "running",
      Health: "",
      Publishers: [{ PublishedPort: 3000 }, { PublishedPort: 8080 }],
    });
    expect(parseContainerInfo(`${line1}\n${line2}`)?.ports).toEqual([3000, 8080]);
  });

  it("skips JSONL lines with invalid JSON but keeps the valid ones", () => {
    const valid = JSON.stringify({ State: "running", Health: "", Publishers: [] });
    expect(parseContainerInfo(`garbage\n${valid}`)).toEqual({
      state: "running",
      health: "",
      ports: [],
      ids: [],
    });
  });

  it("returns null for a non-record JSON value", () => {
    expect(parseContainerInfo(JSON.stringify("hello"))).toBeNull();
  });

  it("returns null for an array of non-objects", () => {
    expect(parseContainerInfo(JSON.stringify(["a", "b"]))).toBeNull();
  });
});

describe("isReady", () => {
  it("running + no healthcheck → ready", () => {
    expect(isReady({ state: "running", health: "", ports: [], ids: [] })).toBe(true);
  });
  it("running + healthy → ready", () => {
    expect(isReady({ state: "running", health: "healthy", ports: [5432], ids: [] })).toBe(true);
  });
  it("running + unhealthy → not ready", () => {
    expect(isReady({ state: "running", health: "unhealthy", ports: [], ids: [] })).toBe(false);
  });
  it("exited → not ready", () => {
    expect(isReady({ state: "exited", health: "", ports: [], ids: [] })).toBe(false);
  });
});

describe("sanitizeProjectName", () => {
  it("lowercases and replaces chars outside [a-z0-9_-] with -", () => {
    expect(sanitizeProjectName("My App!")).toBe("my-app-");
  });
  it("keeps underscores and hyphens", () => {
    expect(sanitizeProjectName("my_app-1")).toBe("my_app-1");
  });
});

describe("composeProjectArgs", () => {
  const origEnv = process.env.ZAPS_COMPOSE_PROJECT;
  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.ZAPS_COMPOSE_PROJECT;
    } else {
      process.env.ZAPS_COMPOSE_PROJECT = origEnv;
    }
  });

  it("uses docker.projectName first", () => {
    process.env.ZAPS_COMPOSE_PROJECT = "envproj";
    expect(composeProjectArgs("/x/backend", { projectName: "cfgproj" })).toEqual(["-p", "cfgproj"]);
  });

  it("uses ZAPS_COMPOSE_PROJECT when no projectName", () => {
    process.env.ZAPS_COMPOSE_PROJECT = "envproj";
    expect(composeProjectArgs("/x/backend", {})).toEqual(["-p", "envproj"]);
  });

  it("falls back to a deterministic zaps pin", () => {
    delete process.env.ZAPS_COMPOSE_PROJECT;
    const [, name] = composeProjectArgs("/home/me/foo/backend", {});
    expect(name).toMatch(/^zaps-backend-[0-9a-f]{6}$/u);
  });

  it("is deterministic per cwd and distinct for same-basename different paths", () => {
    delete process.env.ZAPS_COMPOSE_PROJECT;
    const [, a1] = composeProjectArgs("/home/me/foo/backend", {});
    const [, a2] = composeProjectArgs("/home/me/foo/backend", {});
    const [, b] = composeProjectArgs("/home/me/bar/backend", {});
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("reads a top-level name: from the compose file", () => {
    delete process.env.ZAPS_COMPOSE_PROJECT;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-compose-"));
    try {
      fs.writeFileSync(path.join(dir, "compose.yaml"), "name: filepinned\nservices: {}\n");
      expect(composeProjectArgs(dir, {})).toEqual(["-p", "filepinned"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("legacyProjectWarning", () => {
  it("returns undefined when the pin equals the legacy name", async () => {
    // ProjectName matching the sanitized basename makes pinned === legacy.
    expect(await legacyProjectWarning("/x/backend", { projectName: "backend" })).toBeUndefined();
  });
});

describe("buildDockerCommand", () => {
  let dir: string;
  beforeEach(() => {
    delete process.env.ZAPS_COMPOSE_PROJECT;
    dir = "/x/proj";
  });

  it("pins the project and builds a minimal up command", () => {
    expect(buildDockerCommand({ service: "postgres", projectName: "proj" }, dir)).toBe(
      "docker compose -p proj up postgres",
    );
  });

  it("includes -f, flags, and the service, after the -p pin", () => {
    expect(
      buildDockerCommand(
        {
          service: "postgres",
          projectName: "proj",
          file: "local.docker-compose.yml",
          build: true,
          forceRecreate: true,
          renewVolumes: true,
        },
        dir,
      ),
    ).toBe(
      "docker compose -p proj -f local.docker-compose.yml up --build --force-recreate -V postgres",
    );
  });

  it("handles an array of services", () => {
    expect(buildDockerCommand({ service: ["postgres", "redis"], projectName: "proj" }, dir)).toBe(
      "docker compose -p proj up postgres redis",
    );
  });

  it("uses the zaps pin when no project name is configured", () => {
    expect(buildDockerCommand({ service: "db" }, "/home/me/app")).toMatch(
      /^docker compose -p zaps-app-[0-9a-f]{6} up db$/u,
    );
  });
});
