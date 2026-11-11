import { describe, expect, it, vi } from "vitest";

import { reportDetachedStartup } from "#src/cli/startup.js";

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn() }));

vi.mock("#src/lib/ipc/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/lib/ipc/client.js")>()),
  ipcSubscribe: subscribe,
}));

describe("detached startup handshake", () => {
  it.each([
    { backend: "shell", params: { startup: true } },
    { backend: undefined, params: undefined },
  ] satisfies { backend: "shell" | undefined; params: unknown }[])(
    "waits for ACK before reporting $backend startup",
    async ({ backend, params }) => {
      let acknowledge: () => void = () => undefined;
      const subscribed = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      const request = vi.fn(async (method: string) => ({
        result: method === "services.startAll" ? { started: "all" } : [],
      }));
      subscribe.mockReturnValue({ ready: Promise.resolve(), subscribed, request, close: vi.fn() });
      const report = reportDetachedStartup("/private/socket", {
        id: "fixture",
        name: "fixture",
        backend,
      });
      await Promise.resolve();
      expect(request).not.toHaveBeenCalled();
      acknowledge();
      await report;
      expect(request).toHaveBeenNthCalledWith(1, "services.startAll", params, 0);
      expect(request).toHaveBeenCalledTimes(backend ? 1 : 2);
    },
  );
});
