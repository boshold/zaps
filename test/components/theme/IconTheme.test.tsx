import { Text } from "ink";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ICON_MAPS, SPINNER_FRAMES } from "../../../src/components/theme/icons.js";
import type { IconKey } from "../../../src/components/theme/icons.js";
import {
  IconThemeProvider,
  createIconTheme,
  resolveIconTier,
  useIcons,
} from "../../../src/components/theme/IconTheme.js";

const TIERS = ["nerd", "unicode", "ascii"] as const;
const ALL_KEYS: IconKey[] = Object.keys(ICON_MAPS.nerd) as IconKey[];

describe("icon maps", () => {
  it("define every key in all three tiers with a non-empty glyph", () => {
    for (const tier of TIERS) {
      for (const key of ALL_KEYS) {
        expect(ICON_MAPS[tier][key], `${tier}.${key}`).toBeTruthy();
      }
    }
  });

  it("all three tiers share the exact same key set", () => {
    const nerdKeys = Object.keys(ICON_MAPS.nerd).toSorted();
    expect(Object.keys(ICON_MAPS.unicode).toSorted()).toEqual(nerdKeys);
    expect(Object.keys(ICON_MAPS.ascii).toSorted()).toEqual(nerdKeys);
  });

  it("ascii tier uses only 7-bit ASCII (glyphs + spinner)", () => {
    const isAscii = (s: string) => {
      for (let i = 0; i < s.length; i += 1) {
        if (s.charCodeAt(i) > 127) {
          return false;
        }
      }
      return true;
    };
    for (const key of ALL_KEYS) {
      expect(isAscii(ICON_MAPS.ascii[key]), `ascii.${key}=${ICON_MAPS.ascii[key]}`).toBe(true);
    }
    for (const frame of SPINNER_FRAMES.ascii) {
      expect(isAscii(frame), `spinner ${frame}`).toBe(true);
    }
  });

  it("provides spinner frames for every tier", () => {
    for (const tier of TIERS) {
      expect(SPINNER_FRAMES[tier].length).toBeGreaterThan(0);
    }
  });
});

describe("createIconTheme", () => {
  it("resolves keys to the active tier's glyph", () => {
    const theme = createIconTheme("ascii");
    expect(theme.tier).toBe("ascii");
    expect(theme.icon("ready")).toBe(ICON_MAPS.ascii.ready);
    expect(theme.spinnerFrames).toEqual(SPINNER_FRAMES.ascii);
  });
});

describe("resolveIconTier", () => {
  const original = process.env.ZAPS_ICONS;
  beforeEach(() => {
    delete process.env.ZAPS_ICONS;
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env.ZAPS_ICONS;
    } else {
      process.env.ZAPS_ICONS = original;
    }
  });

  it("uses the config tier when no env override is set", () => {
    expect(resolveIconTier("unicode")).toBe("unicode");
  });

  it("defaults to nerd when neither env nor config is set", () => {
    expect(resolveIconTier()).toBe("nerd");
  });

  it("lets a valid ZAPS_ICONS env override beat the config tier", () => {
    process.env.ZAPS_ICONS = "ascii";
    expect(resolveIconTier("nerd")).toBe("ascii");
  });

  it("ignores an invalid ZAPS_ICONS value and falls back to config", () => {
    process.env.ZAPS_ICONS = "emoji";
    expect(resolveIconTier("unicode")).toBe("unicode");
  });
});

describe("useIcons", () => {
  function Probe() {
    const { icon, tier } = useIcons();
    return <Text>{`${tier}:${icon("ready")}`}</Text>;
  }

  it("exposes the active theme via context", () => {
    const { lastFrame } = render(
      <IconThemeProvider value={createIconTheme("ascii")}>
        <Probe />
      </IconThemeProvider>,
    );
    expect(lastFrame()).toContain("ascii:*");
  });
});
