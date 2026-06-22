import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ActionHints } from "../../src/components/ActionHints.js";
import { serviceHints } from "../../src/components/hintText.js";
import { IconThemeProvider, createIconTheme } from "../../src/components/theme/IconTheme.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";

function makeStatus(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return { name: "api", state: "ready", ports: [], retryCount: 0, ...overrides };
}

describe("serviceHints", () => {
  it("returns an empty string when nothing is selected", () => {
    expect(serviceHints(undefined)).toBe("");
  });

  it("notes when the service is unavailable on this system", () => {
    expect(serviceHints(makeStatus({ state: "unavailable" }))).toBe(
      "Service not available on this system",
    );
  });

  it("includes the base keymap for a plain service", () => {
    const hints = serviceHints(makeStatus());
    expect(hints).toContain("[r]estart");
    expect(hints).toContain("[s]top");
    expect(hints).toContain("[l]ogs");
    expect(hints).not.toContain("[o]pen");
    expect(hints).not.toContain("[R]ebuild");
  });

  it("adds [o]pen when the service has a url and [R]ebuild when dockerized", () => {
    const hints = serviceHints(makeStatus({ url: "http://localhost:3000", isDocker: true }));
    expect(hints).toContain("[o]pen");
    expect(hints).toContain("[R]ebuild");
  });
});

describe("ActionHints", () => {
  it("truncates with an ascii ellipsis under the ascii tier when over budget", () => {
    const { lastFrame } = render(
      <IconThemeProvider value={createIconTheme("ascii")}>
        <ActionHints status={makeStatus({ url: "http://x" })} maxWidth={12} />
      </IconThemeProvider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("...");
    // No unicode ellipsis leaked into the ascii frame.
    expect(frame).not.toContain("…");
  });
});
