import { describe, expect, it } from "vitest";

import { fuzzyRank } from "../../src/lib/fuzzy.js";

interface Cmd {
  id: string;
  label: string;
}

const COMMANDS: Cmd[] = [
  { id: "restart", label: "Restart service" },
  { id: "restart-all", label: "Restart all services" },
  { id: "logs", label: "Open logs" },
  { id: "rebuild", label: "Docker rebuild" },
];

const byLabel = (c: Cmd) => c.label;

describe("fuzzyRank", () => {
  it("returns all items in original order for an empty query", () => {
    const ranked = fuzzyRank("", COMMANDS, byLabel);
    expect(ranked.map((r) => r.item.id)).toEqual(["restart", "restart-all", "logs", "rebuild"]);
    expect(ranked.every((r) => r.indexes.length === 0)).toBe(true);
    expect(ranked.every((r) => r.score === 0)).toBe(true);
  });

  it("treats a whitespace-only query as empty", () => {
    const ranked = fuzzyRank("   ", COMMANDS, byLabel);
    expect(ranked).toHaveLength(COMMANDS.length);
    expect(ranked[0].item.id).toBe("restart");
  });

  it("ranks better matches first", () => {
    const ranked = fuzzyRank("logs", COMMANDS, byLabel);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].item.id).toBe("logs");
    // Scores are sorted descending.
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });

  it("filters out non-matching items", () => {
    const ranked = fuzzyRank("zzz", COMMANDS, byLabel);
    expect(ranked).toHaveLength(0);
  });

  it("returns ascending highlight indexes pointing at matched characters", () => {
    const ranked = fuzzyRank("logs", COMMANDS, byLabel);
    const [top] = ranked;
    expect(top.item.id).toBe("logs");
    // Indexes must be ascending.
    for (let i = 1; i < top.indexes.length; i += 1) {
      expect(top.indexes[i]).toBeGreaterThan(top.indexes[i - 1]);
    }
    // Every matched index points at a character of the query (case-insensitive).
    const label = top.item.label.toLowerCase();
    const matched = top.indexes.map((idx) => label[idx]).join("");
    expect("logs").toContain(matched.length > 0 ? matched[0] : "");
    expect(top.indexes.length).toBeGreaterThanOrEqual(4);
  });

  it("respects the limit option", () => {
    const ranked = fuzzyRank("rest", COMMANDS, byLabel, { limit: 1 });
    expect(ranked).toHaveLength(1);
  });

  it("respects the limit option for empty-query passthrough", () => {
    const ranked = fuzzyRank("", COMMANDS, byLabel, { limit: 2 });
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.item.id)).toEqual(["restart", "restart-all"]);
  });
});
