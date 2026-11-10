import { randomUUID } from "node:crypto";

import { createSentra, memoryStorage } from "@bosdev/sentra-core";
import type { Sentra } from "@bosdev/sentra-core";

const SESSION_A = "aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbbbbbb";

async function memorySentra(): Promise<Sentra> {
  return createSentra({ storage: memoryStorage(), sourceMaps: { enabled: false } });
}

interface SyntheticFrame {
  filename: string;
  function?: string;
  lineno?: number;
  colno?: number;
  inApp?: boolean;
}

interface SyntheticEvent {
  session?: string;
  service?: string;
  project?: string;
  eventId?: string;
  level?: string;
  /** Error event when set; message event otherwise. */
  error?: { type: string; value: string; frames?: SyntheticFrame[] };
  message?: string;
  release?: string;
}

function eventPayload(event: SyntheticEvent, eventId: string): Record<string, unknown> {
  const base = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "node",
    level: event.level ?? "error",
    release: event.release,
  };
  if (!event.error) {
    return { ...base, message: event.message ?? "hello" };
  }
  const frames = (event.error.frames ?? []).map((frame) => ({
    filename: frame.filename,
    abs_path: frame.filename,
    function: frame.function ?? "fn",
    lineno: frame.lineno ?? 1,
    colno: frame.colno ?? 1,
    in_app: frame.inApp ?? true,
  }));
  return {
    ...base,
    exception: {
      values: [{ type: event.error.type, value: event.error.value, stacktrace: { frames } }],
    },
  };
}

/** Ingests one Sentry event envelope through `sentra.handle`; returns its event id. */
async function ingestEvent(sentra: Sentra, event: SyntheticEvent): Promise<string> {
  const eventId = event.eventId ?? randomUUID().replaceAll("-", "");
  const project = event.project ?? "proj";
  const session = event.session ?? SESSION_A;
  const service = event.service ?? "web";
  const body = [
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(eventPayload(event, eventId)),
  ].join("\n");
  const response = await sentra.handle(
    new Request(`http://127.0.0.1/${project}/${session}/${service}/api/1/envelope/`, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body,
    }),
  );
  if (!response.ok) {
    throw new Error(`ingest failed: ${response.status} ${await response.text()}`);
  }
  return eventId;
}

export { SESSION_A, SESSION_B, ingestEvent, memorySentra };
export type { SyntheticEvent, SyntheticFrame };
