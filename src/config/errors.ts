export type ConfigErrorKind = "fatal" | "validation" | "notFound";

export interface ConfigErrorOptions {
  kind?: ConfigErrorKind;
  file?: string;
  service?: string;
  task?: string;
  field?: string;
}

/**
 * Typed error thrown by every config-eval failure path.
 *
 * `message` is kept plain (no ANSI) so it is safe across IPC and logs; styling
 * is applied once at the CLI boundary, never stored here.
 */
export class ConfigError extends Error {
  public readonly kind: ConfigErrorKind;
  public readonly file?: string;
  public readonly service?: string;
  public readonly task?: string;
  public readonly field?: string;

  public constructor(message: string, opts: ConfigErrorOptions = {}) {
    super(message);
    this.name = "ConfigError";
    this.kind = opts.kind ?? "validation";
    this.file = opts.file;
    this.service = opts.service;
    this.task = opts.task;
    this.field = opts.field;
  }
}
