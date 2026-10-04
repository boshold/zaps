import { parseDuration } from "@bosdev/sentra-core";

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const EPOCH_MS = /^\d+$/;

export type SentraQueryErrorCode = "invalid_filter" | "not_found";

/** `toString()` yields the IPC error string `<code>: <message>`. */
export class SentraQueryError extends Error {
  public readonly code: SentraQueryErrorCode;

  public constructor(code: SentraQueryErrorCode, message: string) {
    super(message);
    this.name = "SentraQueryError";
    this.code = code;
  }

  public override toString(): string {
    return `${this.code}: ${this.message}`;
  }
}

/** ISO 8601 (kept as string), epoch ms, or a duration meaning "now minus" (both → epoch ms). */
export function parseTimeInput(
  value: string | number,
  flag = "from",
  now = Date.now(),
): string | number {
  if (typeof value === "number") {
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  } else {
    const trimmed = value.trim();
    if (EPOCH_MS.test(trimmed)) {
      return Number(trimmed);
    }
    if (ISO_PREFIX.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) {
      return trimmed;
    }
    const ms = parseDuration(trimmed);
    if (ms !== null) {
      return now - ms;
    }
  }
  throw new SentraQueryError(
    "invalid_filter",
    `Invalid --${flag}: "${value}". Use ISO 8601, epoch ms, or a duration like 10m.`,
  );
}

/** `--since` is a duration only; returns the epoch ms it points to. */
export function parseSinceInput(value: string, now = Date.now()): number {
  const ms = parseDuration(value.trim());
  if (ms === null) {
    throw new SentraQueryError(
      "invalid_filter",
      `Invalid --since: "${value}". Use a duration like 10m.`,
    );
  }
  return now - ms;
}

/** Resolves `since`/`from`/`to` into an absolute `from`/`to` pair. */
export function resolveTimeWindow(
  input: { since?: string; from?: string | number; to?: string | number },
  now = Date.now(),
): { from?: string | number; to?: string | number } {
  if (input.since !== undefined && input.from !== undefined) {
    throw new SentraQueryError("invalid_filter", "--since and --from cannot be combined.");
  }
  const window: { from?: string | number; to?: string | number } = {};
  if (input.since !== undefined) {
    window.from = parseSinceInput(input.since, now);
  } else if (input.from !== undefined) {
    window.from = parseTimeInput(input.from, "from", now);
  }
  if (input.to !== undefined) {
    window.to = parseTimeInput(input.to, "to", now);
  }
  return window;
}
