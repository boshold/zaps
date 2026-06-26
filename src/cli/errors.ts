import chalk from "chalk";

import { ConfigError } from "#src/config/index.js";

const defaultDeps: RenderErrorDeps = {
  write: (text) => {
    process.stderr.write(text);
  },
  exit: (code) => process.exit(code),
};

export interface RenderErrorDeps {
  write: (text: string) => void;
  exit: (code: number) => never;
}

/**
 * Render an error at the CLI boundary and exit(1). A `ConfigError` is styled
 * with a red `✖` prefix via chalk (auto-disabled on non-TTY / `NO_COLOR`);
 * anything else prints its plain message. ANSI styling lives here, never in
 * `ConfigError.message`.
 */
export function renderCliError(error: unknown, deps: RenderErrorDeps = defaultDeps): never {
  if (error instanceof ConfigError) {
    deps.write(`\n  ${chalk.bold.red("✖")} ${chalk.red(error.message)}\n`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    deps.write(`${message}\n`);
  }
  return deps.exit(1);
}
