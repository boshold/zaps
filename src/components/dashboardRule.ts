/**
 * Build a full-width horizontal rule, optionally splicing a junction glyph at one
 * column so the rule visually merges with the vertical pane divider (a `┬` in the
 * header rule above the body, a `┴` in the footer rule below it). `fill` and
 * `junction` come from the icon tier, so the ascii 7-bit invariant holds.
 */
export function buildRule(
  width: number,
  fill: string,
  junction?: { char: string; col: number },
): string {
  if (!junction || junction.col < 0 || junction.col >= width) {
    return fill.repeat(width);
  }
  return fill.repeat(junction.col) + junction.char + fill.repeat(width - junction.col - 1);
}
