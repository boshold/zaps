import { encode } from "@toon-format/toon";

export type OutputFormat = "text" | "json" | "toon";

export function resolveFormat(opts: { json?: boolean; toon?: boolean }): OutputFormat {
  if (opts.json) {
    return "json";
  }
  if (opts.toon || process.env["CLAUDE_CODE"]) {
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
