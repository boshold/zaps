import { describe, expect, it } from "vitest";

import type { ProjectedServiceStatus } from "../../../src/daemon/session.js";
import {
  canLaunchTask,
  canRebuildDocker,
  canZoomDashboard,
  effectiveTaskMode,
  serviceAvailability,
} from "../../../src/lib/backend/capabilities.js";
import { unavailableActions, unavailableCapabilities } from "../../../src/lib/backend/wire.js";
import {
  fullCapabilities,
  liveActions,
  mixedCapabilities,
} from "../../_helpers/ui-capabilities.js";

const stopped: ProjectedServiceStatus = {
  name: "web",
  state: "stopped",
  ports: [],
  retryCount: 0,
  isDocker: true,
  actions: liveActions,
};

describe("serviceAvailability", () => {
  it.each([
    ["shell", unavailableCapabilities, stopped, false, false, false, false],
    ["mixed", mixedCapabilities, stopped, false, true, false, false],
    ["stopped eager pane", fullCapabilities, stopped, false, true, true, true],
    [
      "removed lazy pane",
      fullCapabilities,
      { ...stopped, actions: unavailableActions },
      false,
      false,
      false,
      false,
    ],
    [
      "detached",
      fullCapabilities,
      { ...stopped, actions: unavailableActions, isDetached: true },
      false,
      false,
      false,
      false,
    ],
    ["busy", fullCapabilities, stopped, true, true, true, false],
    ["popup without zoom", { ...fullCapabilities, zoom: false }, stopped, false, true, false, true],
    ["no panes", { ...fullCapabilities, panes: false }, stopped, false, false, false, false],
    [
      "focus denied",
      fullCapabilities,
      { ...stopped, actions: { ...liveActions, focus: false } },
      false,
      false,
      true,
      true,
    ],
    [
      "zoom denied",
      fullCapabilities,
      { ...stopped, actions: { ...liveActions, zoom: false } },
      false,
      true,
      false,
      true,
    ],
    [
      "editor denied",
      fullCapabilities,
      { ...stopped, actions: { ...liveActions, editOutput: false } },
      false,
      true,
      true,
      false,
    ],
  ])("%s", (_label, capabilities, service, busy, focus, zoom, editOutput) => {
    expect(serviceAvailability(capabilities, service, busy)).toEqual({
      control: !busy,
      logs: true,
      rebuild: !busy,
      focus,
      zoom,
      editOutput,
    });
  });

  it("suppresses unavailable service actions and retains independent dashboard zoom", () => {
    const service: ProjectedServiceStatus = { ...stopped, state: "unavailable" };
    expect(serviceAvailability(fullCapabilities, service)).toEqual({
      control: false,
      logs: false,
      rebuild: false,
      focus: false,
      zoom: false,
      editOutput: false,
    });
    expect(canZoomDashboard(fullCapabilities)).toBe(true);
    expect(canZoomDashboard(mixedCapabilities)).toBe(false);
  });

  it("requires a positive action flag for pane dispatch", () => {
    expect(
      serviceAvailability(fullCapabilities, {
        name: "legacy",
        state: "ready",
        ports: [],
        retryCount: 0,
        paneId: "%1",
      }),
    ).toMatchObject({ focus: false, zoom: false, editOutput: false });
  });
});

describe("Docker rebuild", () => {
  it.each([
    [true, undefined, true],
    [true, "compose", false],
    [true, "", false],
    [false, undefined, false],
    [undefined, undefined, false],
  ])("Docker=%s group=%s", (docker, group, expected) => {
    expect(canRebuildDocker(docker, group)).toBe(expected);
    expect(
      serviceAvailability(unavailableCapabilities, {
        ...stopped,
        isDocker: docker,
        group,
      }).rebuild,
    ).toBe(expected);
  });
});

describe("task presentation", () => {
  it.each([
    ["shell", unavailableCapabilities, "background"],
    ["mixed", mixedCapabilities, "pane"],
    ["popups only", { ...unavailableCapabilities, popups: true }, "background"],
    ["task panes only", { ...unavailableCapabilities, taskPanes: true }, "pane"],
  ])("%s", (_label, capabilities, expected) => {
    expect(effectiveTaskMode("pane", capabilities)).toBe(expected);
    expect(canLaunchTask("pane", capabilities)).toBe(expected === "pane");
    expect(canLaunchTask("background", capabilities)).toBe(true);
    expect(effectiveTaskMode("background", capabilities)).toBe("background");
  });
});
