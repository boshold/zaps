import { ConfigError } from "#src/config/index.js";

/**
 * Log a config-eval failure to the daemon's stderr (redirected to the daemon log
 * file). The full `ConfigError` attribution (kind/file/service/task/field) is
 * recorded here because only `.message` crosses the IPC boundary back to the CLI.
 */
export function logConfigError(error: unknown): void {
  if (error instanceof ConfigError) {
    const parts = [`kind=${error.kind}`];
    if (error.file !== undefined) {
      parts.push(`file=${error.file}`);
    }
    if (error.service !== undefined) {
      parts.push(`service=${error.service}`);
    }
    if (error.task !== undefined) {
      parts.push(`task=${error.task}`);
    }
    if (error.field !== undefined) {
      parts.push(`field=${error.field}`);
    }
    process.stderr.write(`ConfigError [${parts.join(" ")}]: ${error.message}\n`);
    return;
  }
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
}
