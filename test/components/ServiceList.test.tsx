import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ServiceList } from "../../src/components/ServiceList.js";
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

describe("ServiceList", () => {
  it("renders all services without maxRows", () => {
    const statuses = [makeStatus({ name: "api" }), makeStatus({ name: "db" })];
    const { lastFrame } = render(<ServiceList statuses={statuses} selectedIndex={0} cols={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("api");
    expect(frame).toContain("db");
  });

  it("renders group header for first service in group", () => {
    const statuses = [
      makeStatus({ name: "api", group: "backend" }),
      makeStatus({ name: "worker", group: "backend" }),
    ];
    const { lastFrame } = render(<ServiceList statuses={statuses} selectedIndex={0} cols={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("backend");
  });

  it("does not repeat group header for subsequent services in same group", () => {
    const statuses = [
      makeStatus({ name: "api", group: "backend" }),
      makeStatus({ name: "worker", group: "backend" }),
    ];
    const { lastFrame } = render(<ServiceList statuses={statuses} selectedIndex={0} cols={80} />);
    const frame = lastFrame() ?? "";
    // "backend" should appear only once as a header
    expect(frame.indexOf("backend")).toBe(frame.lastIndexOf("backend"));
  });

  it("shows separate group headers for different groups", () => {
    const statuses = [
      makeStatus({ name: "api", group: "backend" }),
      makeStatus({ name: "web", group: "frontend" }),
    ];
    const { lastFrame } = render(<ServiceList statuses={statuses} selectedIndex={0} cols={80} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("backend");
    expect(frame).toContain("frontend");
  });

  it("no group header for ungrouped services", () => {
    const statuses = [makeStatus({ name: "api" }), makeStatus({ name: "db" })];
    const { lastFrame } = render(<ServiceList statuses={statuses} selectedIndex={0} cols={80} />);
    const frame = lastFrame() ?? "";
    // No group label should appear
    expect(frame).not.toMatch(/^\s+backend/m);
  });

  it("renders scroll down indicator when maxRows < total", () => {
    const statuses = Array.from({ length: 10 }, (_, i) => makeStatus({ name: `svc${i}` }));
    const { lastFrame } = render(
      <ServiceList statuses={statuses} selectedIndex={0} maxRows={4} cols={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("↓");
  });

  it("renders scroll up indicator when scrolled down", () => {
    const statuses = Array.from({ length: 10 }, (_, i) => makeStatus({ name: `svc${i}` }));
    const { lastFrame } = render(
      <ServiceList statuses={statuses} selectedIndex={9} maxRows={4} cols={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("↑");
  });

  it("no scroll indicators when total fits in maxRows", () => {
    const statuses = [makeStatus({ name: "api" }), makeStatus({ name: "db" })];
    const { lastFrame } = render(
      <ServiceList statuses={statuses} selectedIndex={0} maxRows={10} cols={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("↑");
    expect(frame).not.toContain("↓");
  });

  it("renders with maxRows=0 (no limit path)", () => {
    const statuses = [makeStatus({ name: "api" }), makeStatus({ name: "db" })];
    const { lastFrame } = render(
      <ServiceList statuses={statuses} selectedIndex={0} maxRows={0} cols={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("api");
    expect(frame).toContain("db");
  });
});
