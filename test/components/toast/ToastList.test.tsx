import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ToastList } from "../../../src/components/toast/ToastList.js";
import type { Toast } from "../../../src/hooks/useToasts.js";

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

describe("ToastList", () => {
  it("renders one line per visible toast", () => {
    const { lastFrame } = render(
      <ToastList
        toasts={[
          toast({ id: "a", level: "success", message: "Build succeeded" }),
          toast({ id: "b", level: "info", message: "Reloaded config" }),
        ]}
        stickyTotal={0}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Build succeeded");
    expect(frame).toContain("Reloaded config");
    // No sticky failures → no acknowledge badge.
    expect(frame).not.toContain("[x] dismiss");
  });

  it("shows a persistent acknowledge badge while a sticky failure is outstanding", () => {
    const { lastFrame } = render(
      <ToastList
        toasts={[toast({ id: "a", level: "error", message: "Build failed", sticky: true })]}
        stickyTotal={1}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Build failed");
    expect(frame).toContain("1 failure");
    expect(frame).toContain("[f] view");
    expect(frame).toContain("[x] dismiss");
  });

  it("pluralizes the failure badge", () => {
    const { lastFrame } = render(<ToastList toasts={[]} stickyTotal={3} />);
    expect(lastFrame() ?? "").toContain("3 failures");
  });

  it("does not overflow: renders at most the visible toasts plus one badge line", () => {
    const visible = [
      toast({ id: "a", message: "one" }),
      toast({ id: "b", message: "two" }),
      toast({ id: "c", message: "three" }),
    ];
    const { lastFrame } = render(<ToastList toasts={visible} stickyTotal={2} />);
    const lines = (lastFrame() ?? "").split("\n").filter((l) => l.trim().length > 0);
    // 3 toast lines + 1 badge line.
    expect(lines).toHaveLength(4);
  });
});
