import type { UiIconTheme } from "#src/config/types.js";

/** Icon tier — same set as `ui.icons`. */
type IconTier = UiIconTheme;

/** Semantic glyph keys. Every current UI symbol resolves through one of these. */
type IconKey =
  // Service states
  | "ready"
  | "working"
  | "stopped"
  | "error"
  | "unavailable"
  | "alert"
  // List chrome
  | "selection"
  | "overflowUp"
  | "overflowDown"
  | "divider"
  | "treeBranch"
  | "dividerTop"
  | "dividerBottom"
  // Task results
  | "taskSuccess"
  | "taskError"
  | "taskPending"
  // Text punctuation (kept ascii-foldable for the ascii tier)
  | "ellipsis"
  | "dash"
  | "dot"
  // Misc semantic markers
  | "docker"
  | "url"
  | "live"
  | "paused"
  | "logo";

type IconMap = Record<IconKey, string>;

// The nerd/unicode tiers preserve the pre-theme visuals exactly (so the default
// Render is unchanged), while the ascii tier is strictly 7-bit so plain terminals
// Stay legible end-to-end. Color is never the only signal — each ascii state has
// A distinct glyph (accessibility invariant).
const nerd: IconMap = {
  ready: "●",
  working: "◐",
  stopped: "○",
  error: "✖",
  unavailable: "○",
  alert: "⚠",
  selection: ">",
  overflowUp: "↑",
  overflowDown: "↓",
  divider: "─",
  treeBranch: "│",
  dividerTop: "┬",
  dividerBottom: "┴",
  taskSuccess: "✔",
  taskError: "✖",
  taskPending: "○",
  ellipsis: "…",
  dash: "—",
  dot: "·",
  docker: "⬢",
  url: "↗",
  live: "●",
  paused: "⏸",
  logo: "⚡",
};

const unicode: IconMap = { ...nerd };

const ascii: IconMap = {
  ready: "*",
  working: "~",
  stopped: "o",
  error: "x",
  unavailable: "-",
  alert: "!",
  selection: ">",
  overflowUp: "^",
  overflowDown: "v",
  divider: "-",
  treeBranch: "|",
  dividerTop: "+",
  dividerBottom: "+",
  taskSuccess: "+",
  taskError: "x",
  taskPending: ".",
  ellipsis: "...",
  dash: "-",
  dot: "|",
  docker: "D",
  url: "@",
  live: "*",
  paused: "=",
  logo: "*",
};

const ICON_MAPS: Record<IconTier, IconMap> = { nerd, unicode, ascii };

/** Animated spinner frames per tier (transitional service states). */
const SPINNER_FRAMES: Record<IconTier, string[]> = {
  nerd: ["◐", "◑", "◒", "◓"],
  unicode: ["◐", "◑", "◒", "◓"],
  ascii: ["|", "/", "-", "\\"],
};

export { ICON_MAPS, SPINNER_FRAMES };
export type { IconKey, IconMap, IconTier };
