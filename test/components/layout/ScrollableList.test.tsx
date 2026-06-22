import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ScrollableList } from "../../../src/components/layout/ScrollableList.js";

const items = Array.from({ length: 10 }, (_, i) => `item${i}`);

function renderItem(item: string, _i: number, selected: boolean) {
  return <Text key={item}>{selected ? `>${item}` : item}</Text>;
}

describe("ScrollableList", () => {
  it("windows a list longer than maxHeight and shows the down marker", () => {
    const { lastFrame } = render(
      <ScrollableList items={items} selectedIndex={0} maxHeight={4} renderItem={renderItem} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame.split("\n").length).toBeLessThanOrEqual(4);
    expect(frame).toContain("item0");
    expect(frame).toContain("item2");
    expect(frame).not.toContain("item3");
    // 10 items, 3 visible → 7 below.
    expect(frame).toContain("↓ 7 more");
    expect(frame).not.toContain("↑");
  });

  it("keeps the selected index in view when scrolled to the bottom", () => {
    const { lastFrame } = render(
      <ScrollableList items={items} selectedIndex={9} maxHeight={4} renderItem={renderItem} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(">item9");
    expect(frame).toContain("↑ 7 more");
    expect(frame).not.toContain("↓");
    expect(frame).not.toContain("item0");
  });

  it("clamps an out-of-bounds selectedIndex to the last item", () => {
    const { lastFrame } = render(
      <ScrollableList items={items} selectedIndex={999} maxHeight={4} renderItem={renderItem} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain(">item9");
  });

  it("respects variable row heights", () => {
    // 6 items × 2 lines each = 12 lines, budget 5.
    const tall = Array.from({ length: 6 }, (_, i) => `row${i}`);
    const { lastFrame } = render(
      <ScrollableList
        items={tall}
        selectedIndex={0}
        maxHeight={5}
        rowHeight={() => 2}
        renderItem={(item) => (
          <Box key={item} flexDirection="column">
            <Text>{item}</Text>
            <Text>{`${item}-cont`}</Text>
          </Box>
        )}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame.split("\n").length).toBeLessThanOrEqual(5);
    // Two 2-line rows fit (4 lines) + 1 marker line; remaining 4 rows are below.
    expect(frame).toContain("row0");
    expect(frame).toContain("row1");
    expect(frame).toContain("↓ 4 more");
    expect(frame).not.toContain("row2");
  });

  it("omits markers when overflowMarkers is false (and uses the full budget)", () => {
    const { lastFrame } = render(
      <ScrollableList
        items={items}
        selectedIndex={0}
        maxHeight={4}
        overflowMarkers={false}
        renderItem={renderItem}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("↓");
    expect(frame).not.toContain("↑");
    // No reserved marker line → a full 4 rows fit.
    expect(frame).toContain("item3");
    expect(frame).not.toContain("item4");
  });

  it("renders the whole list with no markers when it fits", () => {
    const short = ["a", "b", "c"];
    const { lastFrame } = render(
      <ScrollableList items={short} selectedIndex={0} maxHeight={10} renderItem={renderItem} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("a");
    expect(frame).toContain("c");
    expect(frame).not.toContain("more");
  });

  it("renders nothing for an empty list", () => {
    const { lastFrame } = render(
      <ScrollableList items={[]} selectedIndex={0} maxHeight={4} renderItem={renderItem} />,
    );
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});
