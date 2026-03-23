import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ServiceRow } from "../../src/components/ServiceRow.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";

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
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected />);
    expect(lastFrame()).toContain(">");
  });

  it("does not show selected indicator when isSelected=false", () => {
    const status = makeStatus();
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).not.toMatch(/>/);
  });

  it("shows port when available", () => {
    const status = makeStatus({ ports: [3000] });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toContain(":3000");
  });

  it("shows multiple ports", () => {
    const status = makeStatus({ ports: [3000, 3001] });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toContain(":3000");
    expect(lastFrame()).toContain(":3001");
  });

  it("shows ---- when no ports", () => {
    const status = makeStatus({ ports: [] });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toContain(":----");
  });

  it("shows service name", () => {
    const status = makeStatus({ name: "my-service" });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toContain("my-service");
  });

  it("shows error sub-row when selected and has lastError", () => {
    const status = makeStatus({ state: "error", lastError: "SMTP connection refused" });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("│ Error: SMTP connection refused");
  });

  it("hides error sub-row when not selected", () => {
    const status = makeStatus({ state: "error", lastError: "SMTP connection refused" });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("│ Error:");
  });

  it("shows retry count when retryCount > 0", () => {
    const status = makeStatus({ state: "starting", retryCount: 2 });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toContain("retry 2");
  });

  it("shows state label for non-ready states", () => {
    const status = makeStatus({ state: "starting" });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toContain("starting");
  });

  it("shows url when available", () => {
    const status = makeStatus({ url: "http://localhost:3000" });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toContain("http://localhost:3000");
  });

  it("shows uptime in seconds when readySince is recent", () => {
    const status = makeStatus({ readySince: Date.now() - 30_000 });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toMatch(/Up \d+s/);
  });

  it("shows uptime in minutes", () => {
    const status = makeStatus({ readySince: Date.now() - 120_000 });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toMatch(/Up \d+m/);
  });

  it("shows uptime in hours and minutes", () => {
    const status = makeStatus({ readySince: Date.now() - 3_700_000 });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toMatch(/Up \d+h \d+m/);
  });

  it("shows uptime in hours without minutes when exactly on the hour", () => {
    const status = makeStatus({ readySince: Date.now() - 3_600_000 });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Up 1h");
    expect(frame).not.toMatch(/Up 1h \d+m/);
  });

  it("shows docker indicator when isDocker is true", () => {
    const status = makeStatus({ isDocker: true });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toBeTruthy();
  });

  it("renders medium layout (cols >= 50 < 80) with name and status", () => {
    const status = makeStatus({ name: "api", ports: [3000] });
    const { lastFrame } = render(<ServiceRow status={status} cols={60} isSelected={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("api");
    expect(frame).toContain(":3000");
  });

  it("renders medium layout selected with lastError", () => {
    const status = makeStatus({ state: "error", lastError: "connection refused" });
    const { lastFrame } = render(<ServiceRow status={status} cols={60} isSelected />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("│ Error: connection refused");
  });

  it("renders narrow layout (cols >= 30 < 50) with name and status", () => {
    const status = makeStatus({ name: "api" });
    const { lastFrame } = render(<ServiceRow status={status} cols={40} isSelected={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("api");
  });

  it("renders narrow layout selected with lastError", () => {
    const status = makeStatus({ state: "error", lastError: "timeout" });
    const { lastFrame } = render(<ServiceRow status={status} cols={40} isSelected />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("│ Error: timeout");
  });

  it("renders tiny layout (cols < 30) with name only", () => {
    const status = makeStatus({ name: "api" });
    const { lastFrame } = render(<ServiceRow status={status} cols={20} isSelected={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("api");
  });

  it("renders tiny layout selected", () => {
    const status = makeStatus({ name: "api" });
    const { lastFrame } = render(<ServiceRow status={status} cols={20} isSelected />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(">");
  });

  it("applies indent in wide layout", () => {
    const status = makeStatus({ name: "api" });
    const { lastFrame } = render(
      <ServiceRow status={status} cols={100} isSelected={false} indent />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("api");
  });

  it("applies indent in medium layout", () => {
    const status = makeStatus({ name: "api" });
    const { lastFrame } = render(
      <ServiceRow status={status} cols={60} isSelected={false} indent />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("api");
  });

  it("shows retry count in medium layout", () => {
    const status = makeStatus({ state: "starting", retryCount: 3 });
    const { lastFrame } = render(<ServiceRow status={status} cols={60} isSelected={false} />);
    expect(lastFrame()).toBeTruthy();
  });
});
