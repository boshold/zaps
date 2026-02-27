import { encode } from "@toon-format/toon";

type OutputFormat = "text" | "json" | "toon";

const AGENT_ENV_VARS = [
  "CLAUDECODE", // Claude Code
  "CURSOR_TRACE_DIR", // Cursor IDE
];

export function isCodingAgent(): boolean {
  return AGENT_ENV_VARS.some((key) => process.env[key]);
}

export function resolveFormat(opts: { json?: boolean; toon?: boolean }): OutputFormat {
  if (opts.json) {
    return "json";
  }
  if (opts.toon) {
    return "toon";
  }
  const envFormat = process.env["ZAPS_FORMAT"];
  if (envFormat === "json" || envFormat === "toon") {
    return envFormat;
  }
  if (isCodingAgent()) {
    return "toon";
  }
  return "text";
}

export function writeData(data: unknown, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else if (format === "toon") {
    process.stdout.write(`${encode(data)}\n`);
  }
}

export type { OutputFormat };
