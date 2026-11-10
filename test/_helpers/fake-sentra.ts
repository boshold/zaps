import { vi } from "vitest";

import type { SentraHostLike } from "../../src/lib/sentra/config.js";

export function fakeSentraDsn(service: string): string {
  return `http://sentra@127.0.0.1:9000/proj/sess123/${service}/1`;
}

/** `SentraDeps` with a mocked host; `available: false` simulates a failed start. */
export function fakeSentra(available = true) {
  const host = {
    ensureStarted: vi
      .fn<SentraHostLike["ensureStarted"]>()
      .mockResolvedValue(available ? {} : null),
    getDsn: vi.fn<SentraHostLike["getDsn"]>(
      ({ project, session, service }) =>
        `http://sentra@127.0.0.1:9000/${project}/${session}/${service}/1`,
    ),
    addSourceRoot: vi.fn<SentraHostLike["addSourceRoot"]>(),
    status: vi
      .fn<SentraHostLike["status"]>()
      .mockReturnValue({ reason: available ? null : "port bind failed" }),
  };
  return {
    host,
    project: "proj",
    session: "sess123",
    projectDir: "/test",
    log: vi.fn<(msg: string) => void>(),
  };
}

export const SENTRA_BLOCK = {
  enabled: true,
  env: { SENTRY_DSN: "{dsn}", SHARED: "sentra:{dsn}" },
};
