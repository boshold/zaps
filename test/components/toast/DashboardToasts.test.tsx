import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { Toast } from "../../../src/hooks/useToasts.js";

// Mock the queue so the in-flow strip can be rendered without a provider/effect.
const state = vi.hoisted(() => ({ toasts: [] as Toast[] }));
vi.mock("#src/hooks/useToasts.js", () => ({
  useToasts: () => ({
    toasts: state.toasts,
    notify: () => "",
    dismiss: () => undefined,
    ackAll: () => undefined,
  }),
}));

const { DashboardToasts } = await import("../../../src/components/toast/DashboardToasts.js");

function toast(overrides: Partial<Toast>): Toast {
  return {
    id: "t1",
    level: "info",
    message: "hello",
    runId: null,
    sticky: false,
    createdAt: 0,
    ...overrides,
  };
}

describe("DashboardToasts", () => {
  it("renders nothing when the queue is empty (no reserved rows)", () => {
    state.toasts = [];
    const { lastFrame } = render(<DashboardToasts />);
    expect(lastFrame() ?? "").toBe("");
  });

  it("renders the toast strip + sticky failure badge in flow", () => {
    state.toasts = [
      toast({ id: "a", level: "error", message: "Prisma deploy failed", sticky: true }),
    ];
    const { lastFrame } = render(<DashboardToasts />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Prisma deploy failed");
    expect(frame).toContain("1 failure");
    expect(frame).toContain("[x] dismiss");
  });

  it("keeps only the most recent toasts visible", () => {
    state.toasts = Array.from({ length: 5 }, (_, i) =>
      toast({ id: `t${String(i)}`, message: `msg-${String(i)}` }),
    );
    const { lastFrame } = render(<DashboardToasts />);
    const frame = lastFrame() ?? "";
    // Oldest two scroll off; the last three remain.
    expect(frame).not.toContain("msg-0");
    expect(frame).not.toContain("msg-1");
    expect(frame).toContain("msg-4");
  });
});
