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
  // List chrome
  | "selection"
  | "overflowUp"
  | "overflowDown"
  | "divider"
  | "treeBranch"
  // Task results
  | "taskSuccess"
  | "taskError"
  | "taskPending"
  // Misc semantic markers
  | "docker"
  | "url"
  | "live"
  | "paused"
  | "logo";

type IconMap = Record<IconKey, string>;

// Nerd/Unicode tiers use expressive BMP glyphs (a Nerd font is a Unicode
// Superset, so these render on both). The ascii tier is strictly 7-bit so plain
// Terminals stay legible. Color is never the only signal — each state has a
// Distinct glyph (accessibility invariant).
const nerd: IconMap = {
  ready: "●",
  working: "◐",
  stopped: "○",
  error: "✖",
  unavailable: "⊘",
  selection: "❯",
  overflowUp: "▲",
  overflowDown: "▼",
  divider: "─",
  treeBranch: "│",
  taskSuccess: "✔",
  taskError: "✖",
  taskPending: "○",
  docker: "⬢",
  url: "↗",
  live: "●",
  paused: "⏸",
  logo: "⚡",
};

const unicode: IconMap = {
  ready: "●",
  working: "◐",
  stopped: "○",
  error: "✖",
  unavailable: "⊘",
  selection: "›",
  overflowUp: "▲",
  overflowDown: "▼",
  divider: "─",
  treeBranch: "│",
  taskSuccess: "✔",
  taskError: "✖",
  taskPending: "○",
  docker: "⬢",
  url: "↗",
  live: "●",
  paused: "⏸",
  logo: "⚡",
};

const ascii: IconMap = {
  ready: "*",
  working: "~",
  stopped: "o",
  error: "x",
  unavailable: "-",
  selection: ">",
  overflowUp: "^",
  overflowDown: "v",
  divider: "-",
  treeBranch: "|",
  taskSuccess: "+",
  taskError: "x",
  taskPending: ".",
  docker: "D",
  url: "@",
  live: "*",
  paused: "=",
  logo: "*",
};

const ICON_MAPS: Record<IconTier, IconMap> = { nerd, unicode, ascii };

/** Animated spinner frames per tier (transitional service states). */
const SPINNER_FRAMES: Record<IconTier, string[]> = {
  nerd: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  unicode: ["◐", "◑", "◒", "◓"],
  ascii: ["|", "/", "-", "\\"],
};

export { ICON_MAPS, SPINNER_FRAMES };
export type { IconKey, IconMap, IconTier };
