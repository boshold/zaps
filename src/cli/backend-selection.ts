import { backendIdSchema } from "#src/lib/backend/schemas.js";
import type { BackendErrorCode } from "#src/lib/backend/schemas.js";
import type { BackendId } from "#src/lib/backend/types.js";

interface StartupIntent {
  readonly explicitBackend: BackendId | undefined;
  readonly background: boolean;
  readonly detach: boolean;
}

type StartupArguments =
  | { readonly kind: "dispatch"; readonly argv: string[] }
  | { readonly kind: "startup"; readonly argv: string[]; readonly intent: StartupIntent };

interface StartupSelection {
  readonly backend: BackendId;
  readonly attachUi: boolean;
}

class StartupArgumentError extends Error {
  public readonly code: BackendErrorCode;

  public constructor(code: BackendErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "StartupArgumentError";
  }
}

function invalidRequest(message: string): never {
  throw new StartupArgumentError("invalid_request", message);
}

function parseBackend(value: string | undefined): BackendId {
  if (value === undefined) {
    invalidRequest("Option '-B, --backend' requires a value.");
  }
  const parsed = backendIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new StartupArgumentError(
      "invalid_backend",
      `Unknown backend '${value}'. Expected 'tmux' or 'shell'.`,
    );
  }
  return parsed.data;
}

interface ArgumentState {
  intent: { explicitBackend: BackendId | undefined; background: boolean; detach: boolean };
  startupFlag: boolean;
  command: string | undefined;
  upIndex: number;
  leadingSession: boolean;
  help: boolean;
  version: boolean;
  invalidOption: string | undefined;
}

const flagNames = new Map([
  ["-s", "session"],
  ["--session", "session"],
  ["-ds", "session-detach"],
  ["-h", "help"],
  ["--help", "help"],
  ["-V", "version"],
  ["--version", "version"],
  ["-b", "background"],
  ["--background", "background"],
  ["-B", "backend"],
  ["--backend", "backend"],
  ["-d", "detach"],
  ["--detach", "detach"],
]);

function optionValue(
  argv: readonly string[],
  index: number,
  inline: string | undefined,
  allowFlag = false,
) {
  const next = argv[index + 1];
  if (inline === undefined && next !== undefined && (allowFlag || !next.startsWith("-"))) {
    return { value: next, index: index + 1 };
  }
  return { value: inline, index };
}

function consumeSession(
  argv: readonly string[],
  index: number,
  inline: string | undefined,
  state: ArgumentState,
): number {
  const result = optionValue(argv, index, inline, state.leadingSession);
  if (result.value === undefined) {
    state.invalidOption = argv[index];
  }
  return result.index;
}

function consumeFlag(
  argv: readonly string[],
  index: number,
  flag: string,
  inline: string | undefined,
  state: ArgumentState,
): number {
  switch (flagNames.get(flag)) {
    case "help": {
      state.help = inline !== "false";
      break;
    }
    case "version": {
      state.version = inline !== "false";
      break;
    }
    case "background": {
      state.startupFlag = true;
      state.intent.background = inline !== "false";
      break;
    }
    case "backend": {
      state.startupFlag = true;
      const result = optionValue(argv, index, inline);
      const backend = parseBackend(result.value);
      if (state.intent.explicitBackend !== undefined && state.intent.explicitBackend !== backend) {
        invalidRequest("Conflicting backend options. Choose one backend.");
      }
      state.intent.explicitBackend = backend;
      return result.index;
    }
    case "detach": {
      if (state.command !== "up") {
        state.invalidOption = argv[index];
      }
      state.intent.detach = inline !== "false";
      break;
    }
    default: {
      state.invalidOption = argv[index];
      if (/^-[^-]*[bB]/.test(flag) && flag.length > 2) {
        state.startupFlag = true;
      }
      return optionValue(argv, index, inline).index;
    }
  }
  return index;
}

function leadingSessionEnd(argv: readonly string[]): number {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "-s" || token === "--session") {
      index += 2;
    } else if (token.startsWith("--session=")) {
      index += 1;
    } else {
      break;
    }
  }
  return index;
}

function finishArguments(argv: string[], state: ArgumentState): StartupArguments {
  if (state.help || state.command === "help" || (state.version && state.command === undefined)) {
    return { kind: "dispatch", argv };
  }
  if (state.startupFlag && state.command !== undefined && state.command !== "up") {
    invalidRequest("Backend and background options apply only to startup or 'up'.");
  }
  const startup = state.command === "up" || state.startupFlag || argv.length === 0;
  if (!startup) {
    return { kind: "dispatch", argv };
  }
  if (state.invalidOption !== undefined) {
    invalidRequest(
      `Invalid startup option '${state.invalidOption}'. Detach is supported only after 'up'.`,
    );
  }
  if (state.upIndex >= 0) {
    argv.splice(state.upIndex, 1);
  }
  argv.splice(leadingSessionEnd(argv), 0, "up");
  return { kind: "startup", argv, intent: state.intent };
}

/** Keep leading selectors for the CLI hoister; validate retained argv before effects. */
function parseStartupArguments(input: readonly string[]): StartupArguments {
  const argv = [...input];
  const state: ArgumentState = {
    intent: { explicitBackend: undefined, background: false, detach: false },
    startupFlag: false,
    command: undefined,
    upIndex: -1,
    leadingSession: true,
    help: false,
    version: false,
    invalidOption: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }
    const match = /^(?<flag>-{1,2}[^=:.]+)(?:[=:.](?<value>.*))?$/.exec(token);
    const flag = match?.groups?.flag;
    const inline = match?.groups?.value;
    const name = flag === undefined ? undefined : flagNames.get(flag);
    if (name === "session" || (state.command === "up" && name === "session-detach")) {
      if (name === "session-detach") {
        state.intent.detach = true;
      }
      index = consumeSession(argv, index, inline, state);
      continue;
    }
    state.leadingSession = false;
    if (flag !== undefined) {
      index = consumeFlag(argv, index, flag, inline, state);
    } else if (state.command === undefined) {
      state.command = token;
      if (token === "up") {
        state.upIndex = index;
      }
    }
  }
  return finishArguments(argv, state);
}

function selectStartupBackend(
  intent: StartupIntent,
  existingBackend: BackendId | undefined,
): StartupSelection {
  if (
    existingBackend !== undefined &&
    intent.explicitBackend !== undefined &&
    intent.explicitBackend !== existingBackend
  ) {
    throw new StartupArgumentError(
      "backend_conflict",
      `Requested backend '${intent.explicitBackend}' conflicts with running backend '${existingBackend}'. Run 'zaps down' before switching backends.`,
    );
  }
  return {
    backend: existingBackend ?? intent.explicitBackend ?? (intent.background ? "shell" : "tmux"),
    attachUi: !intent.background && !intent.detach,
  };
}

export { StartupArgumentError, parseStartupArguments, selectStartupBackend };
export type { StartupArguments, StartupIntent, StartupSelection };
