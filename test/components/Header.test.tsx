import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { Header } from "../../src/components/Header.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";

function makeStatus(name: string, state: ServiceStatus["state"] = "ready"): ServiceStatus {
  return { name, state, ports: [], retryCount: 0 };
}

describe("Header", () => {
  it("renders project name", () => {
    const { lastFrame } = render(<Header projectName="my-project" statuses={[]} width={80} />);
    expect(lastFrame()).toContain("zaps:");
    expect(lastFrame()).toContain("my-project");
  });

  it("renders separator line matching width", () => {
    const { lastFrame } = render(<Header projectName="test" statuses={[]} width={40} />);
    expect(lastFrame()).toContain("─".repeat(40));
  });

  it("renders status summary counts", () => {
    const statuses = [
      makeStatus("a", "ready"),
      makeStatus("b", "ready"),
      makeStatus("c", "error"),
      makeStatus("d", "starting"),
    ];
    const { lastFrame } = render(<Header projectName="test" statuses={statuses} width={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("2 ready");
    expect(frame).toContain("1 error");
    expect(frame).toContain("1 starting");
  });
});
