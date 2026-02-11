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
    expect(lastFrame()).not.toMatch(/>/);
  });

  it("shows port when available", () => {
    const status = makeStatus({ ports: [3000] });
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    expect(lastFrame()).toContain(":3000");
  });

  it("shows multiple ports", () => {
    const status = makeStatus({ ports: [3000, 3001] });
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    expect(lastFrame()).toContain(":3000");
    expect(lastFrame()).toContain(":3001");
  });

  it("shows ---- when no ports", () => {
    const status = makeStatus({ ports: [] });
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    expect(lastFrame()).toContain(":----");
  });

  it("shows service name", () => {
    const status = makeStatus({ name: "my-service" });
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    expect(lastFrame()).toContain("my-service");
  });

  it("shows error sub-row when selected and has lastError", () => {
    const status = makeStatus({ state: "error", lastError: "SMTP connection refused" });
    const { lastFrame } = render(<ServiceRow status={status} isSelected />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("│ Error: SMTP connection refused");
  });

  it("hides error sub-row when not selected", () => {
    const status = makeStatus({ state: "error", lastError: "SMTP connection refused" });
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("│ Error:");
  });

  it("shows retry count when retryCount > 0", () => {
    const status = makeStatus({ state: "starting", retryCount: 2 });
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    expect(lastFrame()).toContain("retry 2");
  });

  it("shows state label for non-ready states", () => {
    const status = makeStatus({ state: "starting" });
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    expect(lastFrame()).toContain("starting");
  });

  it("shows url when available", () => {
    const status = makeStatus({ url: "http://localhost:3000" });
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    expect(lastFrame()).toContain("http://localhost:3000");
  });

  it("shows action hints when selected", () => {
    const status = makeStatus();
    const { lastFrame } = render(<ServiceRow status={status} isSelected />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[r]estart");
    expect(frame).toContain("[s]top");
    expect(frame).toContain("[l]ogs");
  });

  it("hides action hints when not selected", () => {
    const status = makeStatus();
    const { lastFrame } = render(<ServiceRow status={status} isSelected={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("[r]estart");
  });

  it("shows [o]pen only when url is set", () => {
    const withUrl = makeStatus({ url: "http://localhost:3000" });
    const withoutUrl = makeStatus();

    const { lastFrame: f1 } = render(<ServiceRow status={withUrl} isSelected />);
    expect(f1()).toContain("[o]pen");

    const { lastFrame: f2 } = render(<ServiceRow status={withoutUrl} isSelected />);
    expect(f2()).not.toContain("[o]pen");
  });
});
