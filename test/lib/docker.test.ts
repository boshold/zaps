import { describe, expect, it } from "vitest";

import { buildDockerCommand, isReady, parseContainerInfo } from "../../src/lib/docker.js";

describe("parseContainerInfo", () => {
  it("parses valid JSON object", () => {
    const json = JSON.stringify({
      State: "running",
      Health: "healthy",
      Publishers: [{ PublishedPort: 5432 }, { PublishedPort: 8080 }],
    });
    const info = parseContainerInfo(json);
    expect(info).toEqual({
      state: "running",
      health: "healthy",
      ports: [5432, 8080],
    });
  });

  it("parses JSON array (takes first entry)", () => {
    const json = JSON.stringify([
      {
        State: "running",
        Health: "",
        Publishers: [{ PublishedPort: 3000 }],
      },
    ]);
    const info = parseContainerInfo(json);
    expect(info).toEqual({
      state: "running",
      health: "",
      ports: [3000],
    });
  });

  it("parses JSONL output (first line)", () => {
    const line1 = JSON.stringify({
      State: "running",
      Health: "healthy",
      Publishers: [{ PublishedPort: 5432 }],
    });
    const line2 = JSON.stringify({ State: "exited", Health: "", Publishers: [] });
    const info = parseContainerInfo(`${line1}\n${line2}`);
    expect(info).toEqual({
      state: "running",
      health: "healthy",
      ports: [5432],
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
    const json = JSON.stringify({ State: "running", Health: "" });
    const info = parseContainerInfo(json);
    expect(info).toEqual({
      state: "running",
      health: "",
      ports: [],
    });
  });

  it("handles missing State and Health fields", () => {
    const json = JSON.stringify({ Publishers: [] });
    const info = parseContainerInfo(json);
    expect(info).toEqual({
      state: "",
      health: "",
      ports: [],
    });
  });

  it("filters out zero and negative ports", () => {
    const json = JSON.stringify({
      State: "running",
      Health: "",
      Publishers: [{ PublishedPort: 0 }, { PublishedPort: -1 }, { PublishedPort: 5432 }],
    });
    const info = parseContainerInfo(json);
    expect(info?.ports).toEqual([5432]);
  });

  it("deduplicates and sorts ports", () => {
    const json = JSON.stringify({
      State: "running",
      Health: "",
      Publishers: [{ PublishedPort: 8080 }, { PublishedPort: 3000 }, { PublishedPort: 8080 }],
    });
    const info = parseContainerInfo(json);
    expect(info?.ports).toEqual([3000, 8080]);
  });

  it("skips JSONL lines with invalid JSON", () => {
    const valid = JSON.stringify({ State: "running", Health: "", Publishers: [] });
    const info = parseContainerInfo(`garbage\n${valid}`);
    expect(info).toEqual({
      state: "running",
      health: "",
      ports: [],
    });
  });
});

describe("isReady", () => {
  it("returns true when running with no healthcheck", () => {
    expect(isReady({ state: "running", health: "", ports: [] })).toBe(true);
  });

  it("returns true when running and healthy", () => {
    expect(isReady({ state: "running", health: "healthy", ports: [5432] })).toBe(true);
  });

  it("returns false when running but unhealthy", () => {
    expect(isReady({ state: "running", health: "unhealthy", ports: [] })).toBe(false);
  });

  it("returns false when running but starting health", () => {
    expect(isReady({ state: "running", health: "starting", ports: [] })).toBe(false);
  });

  it("returns false when exited", () => {
    expect(isReady({ state: "exited", health: "", ports: [] })).toBe(false);
  });

  it("returns false when created", () => {
    expect(isReady({ state: "created", health: "", ports: [] })).toBe(false);
  });
});

describe("buildDockerCommand", () => {
  it("builds minimal command with just service", () => {
    expect(buildDockerCommand({ service: "postgres" })).toBe("docker compose up postgres");
  });

  it("includes -f flag when file is set", () => {
    expect(buildDockerCommand({ service: "postgres", file: "local.docker-compose.yml" })).toBe(
      "docker compose -f local.docker-compose.yml up postgres",
    );
  });

  it("includes --build flag", () => {
    expect(buildDockerCommand({ service: "app", build: true })).toBe(
      "docker compose up --build app",
    );
  });

  it("includes --force-recreate flag", () => {
    expect(buildDockerCommand({ service: "app", forceRecreate: true })).toBe(
      "docker compose up --force-recreate app",
    );
  });

  it("includes -V flag for renewVolumes", () => {
    expect(buildDockerCommand({ service: "db", renewVolumes: true })).toBe(
      "docker compose up -V db",
    );
  });

  it("includes --remove-orphans flag", () => {
    expect(buildDockerCommand({ service: "db", removeOrphans: true })).toBe(
      "docker compose up --remove-orphans db",
    );
  });

  it("includes --pull flag", () => {
    expect(buildDockerCommand({ service: "db", pull: "always" })).toBe(
      "docker compose up --pull always db",
    );
  });

  it("includes --no-deps flag", () => {
    expect(buildDockerCommand({ service: "db", noDeps: true })).toBe(
      "docker compose up --no-deps db",
    );
  });

  it("combines all flags", () => {
    expect(
      buildDockerCommand({
        service: "postgres",
        file: "local.docker-compose.yml",
        build: true,
        forceRecreate: true,
        renewVolumes: true,
      }),
    ).toBe("docker compose -f local.docker-compose.yml up --build --force-recreate -V postgres");
  });

  it("handles array of services", () => {
    const result = buildDockerCommand({ service: ["postgres", "redis"] });
    expect(result).toBe("docker compose up postgres redis");
  });
});
