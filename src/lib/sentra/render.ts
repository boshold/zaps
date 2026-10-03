import { encode } from "@toon-format/toon";

import type { ErrorRow, ErrorsResult, IssuesResult, ShowResult } from "./schemas.js";

const SAFE_ARG = /^[\w@%+=:,./-]+$/;
const LIVE_INDENT = " ".repeat("HH:MM:SS ".length);

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
  return withNext(table("errors", result.errors), nextCmd);
}

function renderIssues(result: IssuesResult, nextCmd: string | null): string {
  return withNext(table("issues", result.issues), nextCmd);
}

function renderShow(result: ShowResult): string {
  return result.markdown;
}

/** `HH:MM:SS <service> <level> <title>` plus an indented `at <location>` line when known. */
function renderLiveLine(row: ErrorRow): string {
  const title = row.title.replaceAll(/\s+/g, " ");
  const head = `${clockTime(row.receivedAt)} ${row.service} ${row.level ?? row.kind} ${title}`;
  return row.location === "" ? head : `${head}\n${LIVE_INDENT}at ${row.location}`;
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

export { buildNextCommand, renderErrors, renderIssues, renderLiveLine, renderShow };
