import { z } from "zod";

import type { Rect } from "#src/lib/tmux-layout.js";

const geometrySchema = z.object({
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});
const nodeSchema = z.discriminatedUnion("t", [
  geometrySchema.extend({ t: z.literal("p") }),
  geometrySchema.extend({ t: z.enum(["h", "v"]), c: z.array(z.unknown()).min(2) }),
]);
const documentSchema = z.object({ V: z.literal(2), L: z.unknown() });

function toRect(geometry: z.infer<typeof geometrySchema>): Rect {
  return { width: geometry.w, height: geometry.h, x: geometry.x, y: geometry.y };
}

function jsonRects(value: unknown): Rect[] {
  const node = nodeSchema.parse(value);
  return node.t === "p" ? [toRect(node)] : node.c.flatMap(jsonRects);
}

export function parseTmuxLayoutRects(output: string): Rect[] {
  if (output.trimStart().startsWith("{")) {
    const value: unknown = JSON.parse(output);
    return jsonRects(documentSchema.parse(value).L);
  }

  z.string()
    .regex(/^[0-9a-f]{4},\d+x\d+,/u)
    .parse(output);
  const leafPattern = /(?<w>\d+)x(?<h>\d+),(?<x>\d+),(?<y>\d+),(?<pane>\d+)(?=[,\]}]|$)/gu;
  const rects: Rect[] = [];
  for (const match of output.matchAll(leafPattern)) {
    const { groups } = match;
    if (!groups) {
      throw new Error("Invalid tmux layout leaf");
    }
    rects.push(
      toRect(
        geometrySchema.parse({
          w: Number(groups.w),
          h: Number(groups.h),
          x: Number(groups.x),
          y: Number(groups.y),
        }),
      ),
    );
  }
  if (rects.length === 0) {
    throw new Error("Tmux layout has no panes");
  }
  return rects;
}
