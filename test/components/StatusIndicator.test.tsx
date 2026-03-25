import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { StatusIndicator } from "../../src/components/StatusIndicator.js";
import type { ServiceState } from "../../src/lib/service/types.js";

describe("StatusIndicator", () => {
  it("renders green circle for ready state", () => {
    const { lastFrame } = render(<StatusIndicator state="ready" />);
    expect(lastFrame()).toContain("●");
  });

  it("renders spinner symbol for starting state", () => {
    const { lastFrame } = render(<StatusIndicator state="starting" />);
    // Initial frame is ◐
    expect(lastFrame()).toContain("◐");
  });

  it("renders spinner symbol for stopping state", () => {
    const { lastFrame } = render(<StatusIndicator state="stopping" />);
    expect(lastFrame()).toContain("◐");
  });

  it("renders spinner symbol for restarting state", () => {
    const { lastFrame } = render(<StatusIndicator state="restarting" />);
    expect(lastFrame()).toContain("◐");
  });

  it("renders error symbol for error state", () => {
    const { lastFrame } = render(<StatusIndicator state="error" />);
    expect(lastFrame()).toContain("✖");
  });

  it("renders empty circle for stopped state", () => {
    const { lastFrame } = render(<StatusIndicator state="stopped" />);
    expect(lastFrame()).toContain("○");
  });

  it("renders correct symbol for each state", () => {
    const expected: Record<ServiceState, string> = {
      ready: "●",
      starting: "◐",
      stopping: "◐",
      restarting: "◐",
      error: "✖",
      stopped: "○",
      unavailable: "○",
    };

    for (const [state, symbol] of Object.entries(expected)) {
      const { lastFrame } = render(<StatusIndicator state={state as ServiceState} />);
      expect(lastFrame()).toContain(symbol);
    }
  });
});
