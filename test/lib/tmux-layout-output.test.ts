import { describe, expect, it } from "vitest";

import { parseTmuxLayoutRects } from "../_helpers/tmux-layout-output.js";

const expected = [
  { width: 39, height: 40, x: 0, y: 0 },
  { width: 80, height: 19, x: 40, y: 0 },
  { width: 80, height: 20, x: 40, y: 20 },
];
const tree = {
  t: "h",
  w: 120,
  h: 40,
  x: 0,
  y: 0,
  c: [
    { t: "p", w: 39, h: 40, x: 0, y: 0, i: 0, I: "%0", l: 1 },
    {
      t: "v",
      w: 80,
      h: 40,
      x: 40,
      y: 0,
      c: [
        { t: "p", w: 80, h: 19, x: 40, y: 0, i: 1, I: "%1" },
        { t: "p", w: 80, h: 20, x: 40, y: 20, i: 2, I: "%2", a: true },
      ],
    },
  ],
};

describe("parseTmuxLayoutRects", () => {
  it("preserves depth-first pane order in legacy nested layouts", () => {
    const layout = "abcd,120x40,0,0{39x40,0,0,0,80x40,40,0[80x19,40,0,1,80x20,40,20,2]}";
    expect(parseTmuxLayoutRects(layout)).toEqual(expected);
  });

  it("preserves the same order and geometry in tmux 3.8 JSON layouts", () => {
    expect(parseTmuxLayoutRects(JSON.stringify({ V: 2, L: tree }))).toEqual(expected);
  });

  it("parses a single legacy pane without trailing structural punctuation", () => {
    expect(parseTmuxLayoutRects("abcd,80x24,0,0,0")).toEqual([
      { width: 80, height: 24, x: 0, y: 0 },
    ]);
  });

  it("parses a single JSON pane", () => {
    const pane = { t: "p", w: 80, h: 24, x: 0, y: 0, i: 0, I: "%0" };
    expect(parseTmuxLayoutRects(JSON.stringify({ V: 2, L: pane }))).toEqual([
      { width: 80, height: 24, x: 0, y: 0 },
    ]);
  });

  it.each([
    "not a layout",
    "abcd,80x24,0,0{}",
    JSON.stringify({ V: 1, L: tree }),
    JSON.stringify({ V: 2, L: { t: "p", w: "80", h: 24, x: 0, y: 0 } }),
    JSON.stringify({ V: 2, L: { ...tree, c: [] } }),
    JSON.stringify({ V: 2, L: { ...tree, c: [{ t: "p" }, { t: "p" }] } }),
  ])("rejects invalid layout output: %s", (layout) => {
    expect(() => parseTmuxLayoutRects(layout)).toThrow();
  });
});
