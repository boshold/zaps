import { styleText } from "node:util";

import { ConfigError } from "#src/config/errors.js";
import type { CliHelpers, ConfigNotice, NoticeLevel, NoticeSink } from "#src/config/types.js";

const NOTICE_STYLES: Record<NoticeLevel, { glyph: string; color: "yellow" | "blue" | "green" }> = {
  warn: { glyph: "⚠", color: "yellow" },
  info: { glyph: "ℹ", color: "blue" },
  success: { glyph: "✔", color: "green" },
};

/** Applies `format` only when stderr is a TTY and `NO_COLOR` is unset. */
function paint(format: Parameters<typeof styleText>[0], text: string): string {
  if (process.env.NO_COLOR !== undefined || !process.stderr.isTTY) {
    return text;
  }
  return styleText(format, text, { validateStream: false });
}

/**
 * Default `NoticeSink`: writes `styleText`-styled lines to stderr (one bold
 * glyph + colored message per level). Color auto-disables on non-TTY /
 * `NO_COLOR`. Mirrors `renderCliError`'s `✖` style from P01-T06.
 */
export function createStderrSink(): NoticeSink {
  return (notice: ConfigNotice): void => {
    const { glyph, color } = NOTICE_STYLES[notice.level];
    process.stderr.write(`\n  ${paint(["bold", color], glyph)} ${paint(color, notice.message)}\n`);
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
