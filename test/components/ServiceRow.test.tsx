import type { ServiceStatus } from "../../src/lib/service/types.js";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ServiceRow } from "../../src/components/ServiceRow.js";

function makeStatus(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    name: "api",
    state: "ready",
    ports: [],
    retryCount: 0,
    ...overrides,
  };
}

describe("ServiceRow", () => {
  it("shows selected indicator when isSelected=true", () => {
    const status = makeStatus();
    const { lastFrame } = render(<ServiceRow status={status} isSelected />);
    expect(lastFrame()).toContain(">");
  });

  it("does not show selected indicator when isSelected=false", () => {
    const status = makeStatus();
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    // Should have a space instead of >
    expect(lastFrame()).not.toMatch(/>/);
  });

  it("shows port when available", () => {
    const status = makeStatus({ ports: [3000] });
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    expect(lastFrame()).toContain(":3000");
  });

  it("shows --- when no ports", () => {
    const status = makeStatus({ ports: [] });
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    expect(lastFrame()).toContain(":---");
  });

  it("shows service name", () => {
    const status = makeStatus({ name: "my-service" });
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    expect(lastFrame()).toContain("my-service");
  });

  it("shows restart and stop shortcuts", () => {
    const status = makeStatus();
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    expect(lastFrame()).toContain("[r]");
    expect(lastFrame()).toContain("[s]");
  });
});
