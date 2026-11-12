import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { sessionListEntrySchema } from "#src/lib/backend/schemas.js";
import { daemonStatusSchema, projectedStatusSchema } from "#src/lib/backend/wire.js";

import { createShellTestEnvironment, waitForCondition } from "./helpers.js";
import { writeServiceScript } from "./store-fixture.js";

type Fixture = ReturnType<typeof createShellTestEnvironment>;

const binary = process.env.ZAPS_SHELL_TEST_BINARY;
const command = binary
  ? { file: path.resolve(binary), args: [] }
  : { file: process.execPath, args: [path.resolve("dist/cli.mjs")] };

const listSchema = z.array(sessionListEntrySchema);
const statusSchema = z.array(projectedStatusSchema);
const IMPLICIT_HINT = 'Rerun with --start, or run "zaps up" first.';

function daemonPidFile(fixture: Fixture): string {
  return path.join(fixture.runtimeDir, "zaps", "daemon.pid");
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = createShellTestEnvironment({ command, configName: ".zaps.mts" });
  try {
    await run(fixture);
    fixture.assertNoTmux();
  } finally {
    try {
      if (fs.existsSync(daemonPidFile(fixture))) {
        const stop = await fixture.run(["daemon", "stop"]);
        expect(stop.code, stop.stderr).toBe(0);
        await waitForCondition(() => !fs.existsSync(fixture.socketPath));
      }
    } finally {
      await fixture.cleanup();
    }
  }
}

interface Markers {
  webStarts: string;
  dbStarts: string;
  taskRan: string;
}

/** `web`: autostart; `db`: `flags.start: false`. Each start appends its pid. */
function writeProjectConfig(fixture: Fixture, extraServices = ""): Markers {
  const markers: Markers = {
    webStarts: path.join(fixture.projectDir, "web-starts"),
    dbStarts: path.join(fixture.projectDir, "db-starts"),
    taskRan: path.join(fixture.projectDir, "task-ran"),
  };
  const service = (name: string, marker: string) =>
    writeServiceScript(
      fixture,
      `${name}.mjs`,
      `import fs from "node:fs";
      fs.appendFileSync(${JSON.stringify(marker)}, process.pid + "\\n");
      console.log("READY"); setInterval(() => {}, 1000);`,
    );
  const touch = `${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(${JSON.stringify(markers.taskRan)}, "")'`;
  fs.writeFileSync(
    fixture.configPath,
    `export function config(lib) { return lib.define({
      name: "task-fixture",
      services: {
        web: { start: ${JSON.stringify(service("web", markers.webStarts))}, ready: { output: /READY/ } },
        db: { start: ${JSON.stringify(service("db", markers.dbStarts))}, ready: { output: /READY/ }, flags: { start: false } },
        ${extraServices}
      },
      tasks: {
        independent: { name: "Independent", commands: "echo independent-out" },
        needsSvc: { name: "Needs db", services: ["db"], commands: ${JSON.stringify(touch)} },
        needsSvcAuto: { name: "Needs db (auto)", services: ["db"], autoStart: true, commands: ${JSON.stringify(touch)} },
      },
    }); }\n`,
  );
  return markers;
}

function starts(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
}

async function sessions(fixture: Fixture) {
  return fixture.request("session.list", listSchema);
}

async function waitForNoSession(fixture: Fixture): Promise<void> {
  await waitForCondition(async () => {
    const listed = await sessions(fixture);
    return listed.length === 0;
  });
}

async function stateOf(fixture: Fixture, id: string, name: string) {
  const statuses = await fixture.request("services.list", statusSchema, undefined, id);
  return statuses.find((status) => status.name === name)?.state;
}

describe("tasks without a session", () => {
  it("runs an independent task in a throwaway session", async () => {
    await withFixture(async (fixture) => {
      const markers = writeProjectConfig(fixture);
      const result = await fixture.run(["run", "independent"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("independent-out");
      await waitForNoSession(fixture);
      expect(starts(markers.webStarts)).toEqual([]);
      expect(starts(markers.dbStarts)).toEqual([]);
    });
  });

  it("rejects a task whose service is stopped without running it", async () => {
    await withFixture(async (fixture) => {
      const markers = writeProjectConfig(fixture);
      const result = await fixture.run(["run", "needsSvc"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("db (stopped)");
      expect(result.stderr).toContain(IMPLICIT_HINT);
      expect(fs.existsSync(markers.taskRan)).toBe(false);
      await waitForNoSession(fixture);
      expect(starts(markers.dbStarts)).toEqual([]);
    });
  });

  it("keeps a task-only session after --start until zaps -b runs the startup", async () => {
    await withFixture(async (fixture) => {
      const markers = writeProjectConfig(fixture);
      const result = await fixture.run(["run", "needsSvc", "--start"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("db ready");
      expect(fs.existsSync(markers.taskRan)).toBe(true);
      const [session] = await sessions(fixture);
      expect(session).toMatchObject({ backend: "shell", startupPending: true });
      expect(session).not.toHaveProperty("ephemeral");
      expect(await stateOf(fixture, session.id, "db")).toBe("ready");
      expect(await stateOf(fixture, session.id, "web")).toBe("stopped");
      const ls = await fixture.run(["ls"]);
      expect(ls.stdout).toContain("task-only");

      const background = await fixture.run(["-b"]);
      expect(background.code, background.stderr).toBe(0);
      expect(background.stdout).toContain("started (shell)");
      expect(background.stderr).toContain("created by 'zaps run'");
      expect(await stateOf(fixture, session.id, "web")).toBe("ready");
      expect(await stateOf(fixture, session.id, "db")).toBe("ready");
      expect(starts(markers.dbStarts)).toHaveLength(1);
      const [after] = await sessions(fixture);
      expect(after).not.toHaveProperty("startupPending");
      const lsAfter = await fixture.run(["ls"]);
      expect(lsAfter.stdout).not.toContain("task-only");
    });
  });

  it("reloads a task-only session by restarting only its running service", async () => {
    await withFixture(async (fixture) => {
      const markers = writeProjectConfig(fixture);
      const result = await fixture.run(["run", "needsSvcAuto"]);
      expect(result.code, result.stderr).toBe(0);
      const [session] = await sessions(fixture);
      expect(session.startupPending).toBe(true);
      const reload = await fixture.run(["reload"]);
      expect(reload.code, reload.stderr).toBe(0);
      await waitForCondition(async () => starts(markers.dbStarts).length === 2);
      await waitForCondition(async () => (await stateOf(fixture, session.id, "db")) === "ready");
      expect(await stateOf(fixture, session.id, "web")).toBe("stopped");
      expect(starts(markers.webStarts)).toEqual([]);
      const [after] = await sessions(fixture);
      expect(after.startupPending).toBe(true);
    });
  });

  it("runs two independent tasks concurrently and leaves no session", async () => {
    await withFixture(async (fixture) => {
      const markers = writeProjectConfig(fixture);
      const [first, second] = await Promise.all([
        fixture.run(["run", "independent"]),
        fixture.run(["run", "independent"]),
      ]);
      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      expect(first.stdout).toContain("independent-out");
      expect(second.stdout).toContain("independent-out");
      await waitForNoSession(fixture);
      expect(starts(markers.webStarts)).toEqual([]);
    });
  });

  it("points raw-input configs at tmux", async () => {
    await withFixture(async (fixture) => {
      writeProjectConfig(fixture, `tunnel: { start: "true", raw: true, flags: { start: false } },`);
      const result = await fixture.run(["run", "independent"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'Service "tunnel" uses raw input, which needs tmux. Run "zaps up" first, then "zaps run independent".',
      );
      expect(await sessions(fixture)).toEqual([]);
    });
  });

  it("lists tasks with the daemon stopped and does not start it", async () => {
    await withFixture(async (fixture) => {
      writeProjectConfig(fixture);
      const text = await fixture.run(["tasks"]);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toContain("independent");
      expect(text.stdout).toContain("needsSvcAuto");
      const json = await fixture.run(["tasks", "--json"]);
      expect(json.code, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "needsSvc", requiredServices: ["db"], autoStart: false }),
        ]),
      );
      expect(fs.existsSync(fixture.socketPath)).toBe(false);
      expect(fs.existsSync(daemonPidFile(fixture))).toBe(false);
      await expect(fixture.request("daemon.status", daemonStatusSchema)).rejects.toThrow();
    });
  });
});
