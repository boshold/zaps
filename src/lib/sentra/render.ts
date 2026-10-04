import { encode } from "@toon-format/toon";

import type { ErrorRow, ErrorsResult, IssuesResult, ShowResult } from "./schemas.js";

const SAFE_ARG = /^[\w@%+=:,./-]+$/;
const LIVE_INDENT = " ".repeat("HH:MM:SS ".length);
// C0 controls except tab and newline, DEL, and C1 controls (8-bit CSI/OSC).
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const TERMINAL_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

/** Event fields are untrusted: drop control characters so they cannot drive the terminal. */
function terminalSafe(text: string): string {
  return text.replaceAll(TERMINAL_CONTROL, "");
}

function withNext(body: string, nextCmd: string | null): string {
  return nextCmd === null ? body : `${body}\nnext: ${nextCmd}`;
}

function shellQuote(arg: string): string {
  return SAFE_ARG.test(arg) ? arg : `'${arg.replaceAll("'", String.raw`'\''`)}'`;
}

function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/** TOON prints `key: []` for empty arrays; the spec wants the table header `key[0]:`. */
function table(key: string, rows: object[]): string {
  return rows.length === 0 ? `${key}[0]:` : encode({ [key]: rows });
}

function renderErrors(result: ErrorsResult, nextCmd: string | null): string {
  return terminalSafe(withNext(table("errors", result.errors), nextCmd));
}

function renderIssues(result: IssuesResult, nextCmd: string | null): string {
  return terminalSafe(withNext(table("issues", result.issues), nextCmd));
}

function renderShow(result: ShowResult): string {
  return terminalSafe(result.markdown);
}

/** `HH:MM:SS <service> <level> <title>` plus an indented `at <location>` line when known. */
function renderLiveLine(row: ErrorRow): string {
  const title = terminalSafe(row.title.replaceAll(/\s+/g, " "));
  const service = terminalSafe(row.service);
  const location = terminalSafe(row.location.replaceAll(/\s+/g, " "));
  const head = `${clockTime(row.receivedAt)} ${service} ${row.level ?? row.kind} ${title}`;
  return location === "" ? head : `${head}\n${LIVE_INDENT}at ${location}`;
}

/** `zaps <argv>` with `--skip` set to `skip + limit`; `argv` excludes the binary. */
function buildNextCommand(argv: string[], skip: number, limit: number): string {
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--skip") {
      index += 1;
    } else if (!arg.startsWith("--skip=")) {
      args.push(arg);
    }
  }
  args.push("--skip", String(skip + limit));
  return ["zaps", ...args].map(shellQuote).join(" ");
}

export { buildNextCommand, renderErrors, renderIssues, renderLiveLine, renderShow, terminalSafe };
