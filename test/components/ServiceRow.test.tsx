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

  it("shows a dash when no ports", () => {
    const status = makeStatus({ ports: [] });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toContain("-");
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

  it("shows error sub-row for an unselected stopped dependent of a failed dependency (C4)", () => {
    const status = makeStatus({ state: "stopped", lastError: 'Dependency "db" not ready' });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain('│ Error: Dependency "db" not ready');
  });

  it("shows error sub-row for an unselected errored service (C4)", () => {
    const status = makeStatus({ state: "error", lastError: "crashed" });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame() ?? "").toContain("│ Error: crashed");
  });

  it("hides error sub-row for an unselected non-failed service with a lingering lastError", () => {
    // A running/starting service is not in a failure state — its old lastError stays
    // Hidden unless the row is selected, so the list isn't cluttered with stale errors.
    const status = makeStatus({ state: "starting", lastError: "previous transient error" });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame() ?? "").not.toContain("│ Error:");
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

  it("shows detached marker for a detached service (wide layout)", () => {
    const status = makeStatus({ name: "worker", isDetached: true });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).toContain("detached");
  });

  it("shows detached marker for a detached service (medium layout)", () => {
    const status = makeStatus({ name: "worker", isDetached: true });
    const { lastFrame } = render(<ServiceRow status={status} cols={60} isSelected={false} />);
    expect(lastFrame()).toContain("detached");
  });

  it("does not show detached marker for a pane service", () => {
    const status = makeStatus({ name: "web" });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame()).not.toContain("detached");
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

  it("shows an alert glyph on an unselected errored row", () => {
    const status = makeStatus({ state: "error", lastError: "crashed" });
    const { lastFrame } = render(<ServiceRow status={status} cols={100} isSelected={false} />);
    expect(lastFrame() ?? "").toContain("⚠");
  });

  it("suppresses the inline error but keeps the alert glyph when the detail pane is visible", () => {
    const status = makeStatus({ state: "error", lastError: "crashed" });
    const { lastFrame } = render(
      <ServiceRow status={status} cols={100} isSelected={false} detailVisible />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⚠");
    expect(frame).not.toContain("Error: crashed");
  });

  it("suppresses the inline error for the selected row when the detail pane is visible", () => {
    const status = makeStatus({ state: "error", lastError: "crashed" });
    const { lastFrame } = render(
      <ServiceRow status={status} cols={100} isSelected detailVisible />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(">");
    expect(frame).not.toContain("Error: crashed");
  });
});
