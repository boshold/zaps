import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/open.js", () => ({ openInBrowser: vi.fn() }));

import { createZapsLib } from "../../src/config/builder.js";
import type { ConfigNotice } from "../../src/config/types.js";
import { openInBrowser } from "../../src/lib/open.js";

const mockOpen = vi.mocked(openInBrowser);

afterEach(() => {
  vi.clearAllMocks();
});

describe("lib.browser.open", () => {
  it("emits a warn notice when opening the browser fails", async () => {
    mockOpen.mockRejectedValue(new Error("no browser"));
    const notices: ConfigNotice[] = [];
    const { lib } = createZapsLib({ onNotice: (n) => notices.push(n) });

    await lib.browser.open("http://localhost:3000");

    expect(mockOpen).toHaveBeenCalledWith("http://localhost:3000");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe("warn");
    expect(notices[0]?.message).toContain("http://localhost:3000");
    expect(notices[0]?.message).toContain("no browser");
  });

  it("does not emit a notice on success", async () => {
    mockOpen.mockResolvedValue(undefined);
    const notices: ConfigNotice[] = [];
    const { lib } = createZapsLib({ onNotice: (n) => notices.push(n) });

    await lib.browser.open("http://localhost:3000");

    expect(notices).toHaveLength(0);
  });
});
