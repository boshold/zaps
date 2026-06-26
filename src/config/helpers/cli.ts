import chalk from "chalk";

import { ConfigError } from "#src/config/errors.js";
import type { CliHelpers, ConfigNotice, NoticeLevel, NoticeSink } from "#src/config/types.js";

const NOTICE_STYLES: Record<NoticeLevel, { glyph: string; color: (text: string) => string }> = {
  warn: { glyph: "⚠", color: chalk.yellow },
  info: { glyph: "ℹ", color: chalk.blue },
  success: { glyph: "✔", color: chalk.green },
};

/**
 * Default `NoticeSink`: writes chalk-styled lines to stderr (one bold glyph +
 * colored message per level). chalk auto-disables color on non-TTY / `NO_COLOR`.
 * Mirrors `renderCliError`'s `✖` style from P01-T06.
 */
export function createStderrSink(): NoticeSink {
  return (notice: ConfigNotice): void => {
    const { glyph, color } = NOTICE_STYLES[notice.level];
    process.stderr.write(`\n  ${chalk.bold(color(glyph))} ${color(notice.message)}\n`);
  };
}

/**
 * The `cli` namespace. `fatal` throws a `ConfigError` (`kind: "fatal"`) — it
 * never writes or exits. Its `never` return type lets it stand in any value
 * position, e.g. `name: pkg.name ?? cli.fatal("name required")`.
 * `warn/info/success` emit a `ConfigNotice` through the injected sink, which
 * decides the destination (CLI default → stderr; daemon → broadcast).
 */
export function createCliHelpers(sink: NoticeSink): CliHelpers {
  return {
    fatal(message: string, opts?: { field?: string }): never {
      throw new ConfigError(message, { kind: "fatal", field: opts?.field });
    },
    warn(message: string): void {
      sink({ level: "warn", message });
    },
    info(message: string): void {
      sink({ level: "info", message });
    },
    success(message: string): void {
      sink({ level: "success", message });
    },
  };
}
