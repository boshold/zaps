import { createContext, useContext } from "react";

import { ICON_MAPS, SPINNER_FRAMES } from "./icons.js";
import type { IconKey, IconTier } from "./icons.js";

interface IconTheme {
  /** The active tier. */
  tier: IconTier;
  /** Resolve a semantic key to its glyph for the active tier. */
  icon: (key: IconKey) => string;
  /** Spinner frames for the active tier. */
  spinnerFrames: string[];
}

const IconThemeContext = createContext<IconTheme | null>(null);

const IconThemeProvider = IconThemeContext.Provider;

function isTier(value: string | undefined): value is IconTier {
  return value === "nerd" || value === "unicode" || value === "ascii";
}

/**
 * Resolve the active tier once at startup. `ZAPS_ICONS` env wins (debug / forced
 * override), then `ui.icons` from config, else `nerd` (no reliable runtime glyph
 * detection — default rich, fall back to ascii explicitly).
 */
function resolveIconTier(configTier?: IconTier): IconTier {
  const env = process.env.ZAPS_ICONS;
  if (isTier(env)) {
    return env;
  }
  return configTier ?? "nerd";
}

function createIconTheme(tier: IconTier): IconTheme {
  const map = ICON_MAPS[tier];
  return {
    tier,
    icon: (key) => map[key],
    spinnerFrames: SPINNER_FRAMES[tier],
  };
}

/** Read the active icon theme from the nearest `IconThemeProvider`. */
function useIcons(): IconTheme {
  const ctx = useContext(IconThemeContext);
  if (!ctx) {
    throw new Error("useIcons must be used within an IconThemeProvider");
  }
  return ctx;
}

export { createIconTheme, IconThemeProvider, resolveIconTier, useIcons };
export type { IconTheme };
