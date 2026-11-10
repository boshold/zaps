import fs from "node:fs";
import path from "node:path";

import { DaemonServer } from "#src/daemon/server.js";
import { runWithEnvironment } from "#src/lib/request-context.js";

import { createShellTestEnvironment } from "./helpers.js";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

export async function withShellStore(
  action: (
    fixture: ReturnType<typeof createShellTestEnvironment>,
    store: DaemonServer,
  ) => Promise<void>,
): Promise<void> {
  const fixture = createShellTestEnvironment({ command: { file: process.execPath, args: [] } });
  await runWithEnvironment({ ...fixture.env }, async () => {
    const store = new DaemonServer();
    const errors: unknown[] = [];
    try {
      await action(fixture, store);
    } catch (error) {
      errors.push(error);
    }
    const cleanup = await Promise.allSettled(
      store.ownedSessionIds().map(async (id) => store.destroy(id)),
    );
    const cleanupErrors: unknown[] = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    try {
      await store.sentra.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (errors.length || cleanupErrors.length) {
      fs.writeFileSync(
        path.join(fixture.rootDir, "store-cleanup-error.txt"),
        [...errors, ...cleanupErrors].map(String).join("\n"),
      );
    } else {
      try {
        await fixture.cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      fixture.assertNoTmux();
    } catch (error) {
      errors.push(error);
    }
    errors.push(...cleanupErrors);
    if (errors.length) {
      throw new AggregateError(
        errors,
        `Shell store fixture failed: ${errors.map(String).join("; ")}`,
      );
    }
  });
}

export function writeServiceScript(
  fixture: ReturnType<typeof createShellTestEnvironment>,
  name: string,
  source: string,
): string {
  const file = path.join(fixture.projectDir, name);
  fs.writeFileSync(file, source);
  return `${shellQuote(process.execPath)} ${shellQuote(file)}`;
}
