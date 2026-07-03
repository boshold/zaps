import { styleText } from "node:util";

import { ConfigError } from "#src/config/index.js";

const defaultDeps: RenderErrorDeps = {
  write: (text) => {
    process.stderr.write(text);
  },
  exit: (code) => process.exit(code),
};

/** Applies `format` only when stderr is a TTY and `NO_COLOR` is unset. */
function paint(format: Parameters<typeof styleText>[0], text: string): string {
  if (process.env.NO_COLOR !== undefined || !process.stderr.isTTY) {
    return text;
  }
  return styleText(format, text, { validateStream: false });
}

export interface RenderErrorDeps {
  write: (text: string) => void;
  exit: (code: number) => never;
}

/**
 * Render an error at the CLI boundary and exit(1). A `ConfigError` is styled
 * with a red `✖` prefix via `styleText` (auto-disabled on non-TTY /
 * `NO_COLOR`); anything else prints its plain message. ANSI styling lives
 * here, never in `ConfigError.message`.
 */
export function renderCliError(error: unknown, deps: RenderErrorDeps = defaultDeps): never {
  if (error instanceof ConfigError) {
    deps.write(`\n  ${paint(["bold", "red"], "✖")} ${paint("red", error.message)}\n`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    deps.write(`${message}\n`);
  }
  return deps.exit(1);
}
