import { expect, it, vi } from "vitest";

import { TmuxSessionBackend } from "#src/lib/backend/tmux/session.js";
import type { RuntimeDriver } from "#src/lib/backend/types.js";
import { tmuxFor } from "#src/lib/tmux.js";

it("keeps adopted map separate until presentation notifies the session", async () => {
  const original = { "@tui": "%1" };
  const tmux = tmuxFor("pane-map-regression");
  vi.spyOn(tmux, "splitPane").mockResolvedValue("%2");
  const runtime: RuntimeDriver = {
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(),
    getPid: vi.fn(),
    readOutput: vi.fn(),
    subscribe: vi.fn(),
  };
  const backend = TmuxSessionBackend.adopt(
    {
      host: {
        tmuxSession: "owned",
        tmuxWindow: "@1",
        originPane: "%1",
        tmuxSocket: "pane-map-regression",
        managedTmux: false,
      },
      tmux,
      runtime,
      services: { web: { start: "web" } },
    },
    original,
  );
  const listener = vi.fn(() => expect(original).toEqual({ "@tui": "%1" }));
  backend.subscribePresentation(listener);
  await backend.insertPane("web");
  expect(listener).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ paneMap: { "@tui": "%1", web: "%2" } }),
  );
  expect(original).toEqual({ "@tui": "%1" });
});
