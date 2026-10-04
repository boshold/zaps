import type { Item, LiveEvent, LiveFilter } from "@bosdev/sentra-core";

import type { DaemonEvent } from "#src/lib/ipc/protocol.js";

import { itemLocation, toErrorRow } from "./query.js";
import { renderLiveLine } from "./render.js";
import { liveKindSchema } from "./schemas.js";

type Broadcast = (event: DaemonEvent) => void;

interface SubscribeSource {
  subscribe(filter: LiveFilter, listener: (event: LiveEvent) => void): () => void;
}

interface CounterEntry {
  since: number;
  count: number;
}

function entryKey(sessionId: string, service: string): string {
  return `${sessionId}\0${service}`;
}

/** Same rule as the `zaps sentra errors` default filter. */
export function isCountedError(item: Pick<Item, "kind" | "level">): boolean {
  return (
    (item.kind === "error" || item.kind === "message") &&
    (item.level === "error" || item.level === "fatal")
  );
}

/** Per `(session, service)` error count since the service's last start, plus live broadcast. */
export class ErrorCounter {
  private readonly entries = new Map<string, CounterEntry>();
  private readonly subscriptions = new Map<string, () => void>();
  private readonly source: SubscribeSource;

  public constructor(source: SubscribeSource) {
    this.source = source;
  }

  /** Idempotent; one Sentra subscription per session. */
  public attach(sessionId: string, broadcast: Broadcast): void {
    if (this.subscriptions.has(sessionId)) {
      return;
    }
    const unsubscribe = this.source.subscribe({ session: sessionId }, (event) => {
      this.handle(sessionId, event, broadcast);
    });
    this.subscriptions.set(sessionId, unsubscribe);
  }

  public detach(sessionId: string): void {
    this.subscriptions.get(sessionId)?.();
    this.subscriptions.delete(sessionId);
    const prefix = entryKey(sessionId, "");
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  public reset(sessionId: string, service: string, since: number): void {
    this.entries.set(entryKey(sessionId, service), { since, count: 0 });
  }

  /** `null` when the service never started with Sentra in this daemon. */
  public get(sessionId: string, service: string): number | null {
    return this.entries.get(entryKey(sessionId, service))?.count ?? null;
  }

  /**
   * Re-reads matching counters after a clear, which may delete only part of the
   * counted errors. All of the session's services when `services` is empty.
   */
  public async recount(
    sessionId: string,
    services: string[] | undefined,
    count: (service: string, since: number) => Promise<number>,
  ): Promise<void> {
    const prefix = entryKey(sessionId, "");
    const wanted = services && services.length > 0 ? new Set(services) : null;
    const updates = [...this.entries]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => ({ entry, service: key.slice(prefix.length) }))
      .filter(({ service }) => wanted === null || wanted.has(service))
      .map(async ({ entry, service }) => {
        entry.count = await count(service, entry.since);
      });
    await Promise.all(updates);
  }

  private handle(sessionId: string, event: LiveEvent, broadcast: Broadcast): void {
    if (event.type === "envelope.failed") {
      broadcast({ session: sessionId, event: "sentra.failed", data: { error: event.error } });
      return;
    }
    const { item } = event;
    const entry = this.entries.get(entryKey(sessionId, item.scope.service));
    if (entry && isCountedError(item) && Date.parse(item.receivedAt) >= entry.since) {
      entry.count += 1;
    }
    if (liveKindSchema.safeParse(item.kind).success) {
      const row = toErrorRow(item, itemLocation(item));
      broadcast({
        session: sessionId,
        event: "sentra.item",
        data: { row, line: renderLiveLine(row) },
      });
    }
  }
}
