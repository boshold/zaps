import type { BackendCapabilities, ServiceActions } from "../../src/lib/backend/types.js";

export const fullCapabilities = {
  panes: true,
  zoom: true,
  popups: true,
  taskPanes: true,
  rawInput: true,
  layout: true,
} satisfies BackendCapabilities;

export const mixedCapabilities = {
  panes: true,
  zoom: false,
  popups: false,
  taskPanes: true,
  rawInput: false,
  layout: false,
} satisfies BackendCapabilities;

export const liveActions = {
  focus: true,
  zoom: true,
  editOutput: true,
} satisfies ServiceActions;
