import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ActionHints } from "../../src/components/ActionHints.js";
import { serviceHints } from "../../src/components/hintText.js";
import { IconThemeProvider, createIconTheme } from "../../src/components/theme/IconTheme.js";
import { unavailableActions, unavailableCapabilities } from "../../src/lib/backend/wire.js";
import type { ServiceStatus } from "../../src/lib/service/types.js";
import { fullCapabilities, liveActions } from "../_helpers/ui-capabilities.js";

function makeStatus(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return { name: "api", state: "ready", ports: [], retryCount: 0, ...overrides };
}

describe("serviceHints", () => {
  it("returns an empty string when nothing is selected", () => {
    expect(serviceHints(undefined, unavailableCapabilities)).toBe("");
  });

  it("notes when the service is unavailable on this system", () => {
    expect(serviceHints(makeStatus({ state: "unavailable" }), unavailableCapabilities)).toBe(
      "Service not available on this system",
    );
  });

  it("includes the base keymap for a plain service", () => {
    const hints = serviceHints(makeStatus(), unavailableCapabilities);
    expect(hints).toContain("[r]estart");
    expect(hints).toContain("[s]top");
    expect(hints).toContain("[l]ogs");
    expect(hints).not.toContain("[o]pen");
    expect(hints).not.toContain("[R]ebuild");
  });

  it("adds [o]pen when the service has a url and [R]ebuild when dockerized", () => {
    const hints = serviceHints(
      makeStatus({ url: "http://localhost:3000", isDocker: true }),
      unavailableCapabilities,
    );
    expect(hints).toContain("[o]pen");
    expect(hints).toContain("[R]ebuild");
  });
});

describe("ActionHints", () => {
  it("keeps lifecycle hints when shell or pane removal suppresses service terminal hints", () => {
    const status = {
      ...makeStatus({ state: "stopped", isDocker: true, group: "" }),
      actions: liveActions,
    };
    const { lastFrame, rerender } = render(
      <ActionHints status={status} capabilities={unavailableCapabilities} />,
    );
    expect(lastFrame()).toContain("[r]estart");
    expect(lastFrame()).toContain("[l]ogs");
    for (const hint of ["[z]oom", "[Z]aps zoom", "[E]dit", "[R]ebuild"]) {
      expect(lastFrame()).not.toContain(hint);
    }
    rerender(<ActionHints status={status} capabilities={fullCapabilities} />);
    expect(lastFrame()).toContain("[z]oom");
    expect(lastFrame()).toContain("[E]dit");
    rerender(
      <ActionHints
        status={{ ...status, actions: unavailableActions }}
        capabilities={fullCapabilities}
      />,
    );
    expect(lastFrame()).not.toContain("[z]oom");
    expect(lastFrame()).not.toContain("[E]dit");
    expect(lastFrame()).toContain("[Z]aps zoom");
  });

  it("truncates with an ascii ellipsis under the ascii tier when over budget", () => {
    const { lastFrame } = render(
      <IconThemeProvider value={createIconTheme("ascii")}>
        <ActionHints
          status={makeStatus({ url: "http://x" })}
          capabilities={unavailableCapabilities}
          maxWidth={12}
        />
      </IconThemeProvider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("...");
    // No unicode ellipsis leaked into the ascii frame.
    expect(frame).not.toContain("…");
  });
});
