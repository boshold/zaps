import { LEVELS } from "@boshold/sentra-core";
import type { ItemKind, Level } from "@boshold/sentra-core";

import type { DaemonEvent, IpcResponse } from "#src/lib/ipc/protocol.js";
import { sanitizeSegment } from "#src/lib/sentra/config.js";
import {
  SENTRA_DISABLED_ERROR,
  liveFailedEventSchema,
  liveItemEventSchema,
  statusResultSchema,
} from "#src/lib/sentra/schemas.js";
import type { ErrorRow } from "#src/lib/sentra/schemas.js";
import { describeSentraError, resolveSentraSessionId } from "#src/lib/sentra/session-id.js";

const RETRY_MS = 2000;
const WAITING_MESSAGE = "sentra: waiting for daemon…\n";
const NO_SESSION = "No running zaps session for this project.";

interface LiveFilter {
  service?: string[];
  kind?: ItemKind[];
  level?: Level[];
  minLevel?: Level;
  q?: string;
}

interface LiveSubscription {
  close(): void;
}

interface LiveHandlers {
  onEvent: (event: DaemonEvent) => void;
  onSubscribed: () => void;
  /** Connection closed or the subscribe was rejected (e.g. unknown session). */
  onEnd: () => void;
}

interface LiveDeps {
  subscribe(sessionId: string, handlers: LiveHandlers): LiveSubscription;
  /** IPC that never auto-starts the daemon: live needs a running session. */
  request(method: string, params?: unknown): Promise<IpcResponse>;
  sleep(ms: number): Promise<void>;
  /** Installs the Ctrl-C handler; resolves on Ctrl-C. */
  waitForStop(): Promise<void>;
}

interface LiveContext {
  cwd(): string;
  configSessionId(): string | Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  sessionArg?: string;
  json: boolean;
  live: LiveDeps;
}

/** Per flag, like `buildItemFilter`: kind defaults alone; min-level only without any kind/level flag. */
function withLiveDefaults(filter: LiveFilter): LiveFilter {
  const noLevelFlags =
    filter.kind === undefined && filter.level === undefined && filter.minLevel === undefined;
  return {
    ...filter,
    service: filter.service?.map(sanitizeSegment),
    kind: filter.kind ?? ["error", "message"],
    minLevel: filter.minLevel ?? (noLevelFlags ? "warning" : undefined),
  };
}

function matchesLive(row: ErrorRow, filter: LiveFilter): boolean {
  if (filter.service && !filter.service.includes(row.service)) {
    return false;
  }
  if (filter.kind && !filter.kind.includes(row.kind)) {
    return false;
  }
  if (filter.level && (row.level === null || !filter.level.includes(row.level))) {
    return false;
  }
  if (
    filter.minLevel !== undefined &&
    (row.level === null || LEVELS.indexOf(row.level) < LEVELS.indexOf(filter.minLevel))
  ) {
    return false;
  }
  return filter.q === undefined || row.title.toLowerCase().includes(filter.q.toLowerCase());
}

function handleEvent(ctx: LiveContext, filter: LiveFilter, event: DaemonEvent): void {
  if (event.event === "sentra.failed") {
    const parsed = liveFailedEventSchema.safeParse(event.data);
    if (parsed.success) {
      ctx.stderr(`sentra: failed envelope: ${parsed.data.error}\n`);
    }
    return;
  }
  if (event.event !== "sentra.item") {
    return;
  }
  const parsed = liveItemEventSchema.safeParse(event.data);
  if (!parsed.success || !matchesLive(parsed.data.row, filter)) {
    return;
  }
  ctx.stdout(ctx.json ? `${JSON.stringify(parsed.data.row)}\n` : `${parsed.data.line}\n`);
}

async function resolveLiveSession(ctx: LiveContext, sessions: unknown): Promise<string> {
  return resolveSentraSessionId({
    sessions,
    sessionArg: ctx.sessionArg,
    cwd: ctx.cwd(),
    configSessionId: async () => ctx.configSessionId(),
  });
}

/** Checks once that the session runs and Sentra is usable; returns the session id or an exit code. */
async function checkStart(ctx: LiveContext): Promise<{ sessionId: string } | { code: number }> {
  const list = await ctx.live.request("session.list");
  if (list.error) {
    ctx.stderr(`Error: ${list.error}\n`);
    return { code: 1 };
  }
  const sessionId = await resolveLiveSession(ctx, list.result);
  const res = await ctx.live.request("sentra.status", { sessionId });
  if (res.error) {
    ctx.stderr(`Error: ${describeSentraError(res.error).message}\n`);
    return { code: 1 };
  }
  const status = statusResultSchema.parse(res.result);
  if (status.enabled === null) {
    ctx.stderr(`Error: ${NO_SESSION}\n`);
    return { code: 1 };
  }
  if (!status.enabled || status.state === "disabled") {
    ctx.stderr(`Error: ${describeSentraError(SENTRA_DISABLED_ERROR).message}\n`);
    return { code: 1 };
  }
  if (status.state === "unavailable") {
    ctx.stderr(`Error: Sentra is unavailable: ${status.reason ?? "unknown error"}\n`);
    return { code: 1 };
  }
  return { sessionId };
}

/** Streams until Ctrl-C; reconnects every 2 s while the daemon or session is gone. */
async function runLive(ctx: LiveContext, filterInput: LiveFilter): Promise<number> {
  const filter = withLiveDefaults(filterInput);
  const start = await checkStart(ctx);
  if ("code" in start) {
    return start.code;
  }
  const { live } = ctx;
  const state = { stopped: false };
  const stop = (async () => {
    await live.waitForStop();
    state.stopped = true;
  })();
  let waiting = false;
  let sessionId: string | null = start.sessionId;

  while (!state.stopped) {
    if (sessionId === null) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- retries are sequential
        const list = await live.request("session.list");
        // oxlint-disable-next-line no-await-in-loop -- retries are sequential
        sessionId = list.error ? null : await resolveLiveSession(ctx, list.result);
      } catch {
        sessionId = null;
      }
    }
    if (sessionId !== null) {
      const target = sessionId;
      const holder: { subscription?: LiveSubscription; ended: boolean } = { ended: false };
      // oxlint-disable-next-line no-await-in-loop -- one subscription at a time
      await Promise.race([
        stop,
        new Promise<void>((resolve) => {
          holder.subscription = live.subscribe(target, {
            onEvent: (event) => {
              if (!holder.ended) {
                handleEvent(ctx, filter, event);
              }
            },
            onSubscribed: () => {
              if (!holder.ended) {
                waiting = false;
              }
            },
            // Close and error-ack can both fire; only the first counts.
            onEnd: () => {
              holder.ended = true;
              resolve();
            },
          });
        }),
      ]);
      holder.subscription?.close();
    }
    if (state.stopped) {
      break;
    }
    if (!waiting) {
      ctx.stderr(WAITING_MESSAGE);
      waiting = true;
    }
    sessionId = null;
    // oxlint-disable-next-line no-await-in-loop -- retry delay
    await Promise.race([live.sleep(RETRY_MS), stop]);
  }
  return 0;
}

export { RETRY_MS, WAITING_MESSAGE, matchesLive, runLive, withLiveDefaults };
export type { LiveContext, LiveDeps, LiveFilter, LiveHandlers, LiveSubscription };
