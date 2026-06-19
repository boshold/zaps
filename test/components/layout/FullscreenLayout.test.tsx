import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

// Fixed terminal size so useDimensions reports a deterministic row count.
const fakeStdout = vi.hoisted(() => ({
  columns: 80,
  rows: 24,
  on() {
    /* Empty */
  },
  off() {
    /* Empty */
  },
}));

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return { ...actual, useStdout: () => ({ stdout: fakeStdout }) };
});

const { FullscreenLayout } = await import("../../../src/components/layout/FullscreenLayout.js");
const { useViewportSize } = await import("../../../src/components/layout/ViewportContext.js");

function TallBody({ lines }: { lines: number }) {
  return (
    <Box flexDirection="column">
      {Array.from({ length: lines }, (_, i) => (
        <Text key={i}>{`body-${i}`}</Text>
      ))}
    </Box>
  );
}

function MeasuredBody() {
  const { height, width } = useViewportSize();
  return <Text>{`MEASURED ${height}x${width}`}</Text>;
}

describe("FullscreenLayout", () => {
  it("fills exactly the terminal height with header, body and footer (no overflow/blank)", () => {
    // Body taller than the measured space (25 > ~22): the overflowY="hidden"
    // Safety net must keep the frame at exactly `rows` with chrome intact
    // Rather than overflowing and drifting the alt-screen cursor (the v1 bug).
    const { lastFrame } = render(
      <FullscreenLayout header={<Text>HEADER</Text>} footer={<Text>FOOTER</Text>}>
        <TallBody lines={25} />
      </FullscreenLayout>,
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");

    expect(lines.length).toBe(24);
    expect(frame).toContain("HEADER");
    expect(frame).toContain("FOOTER");
    // First and last visible lines are the chrome — pane is not blank/overflowed.
    expect(lines[0]).toContain("HEADER");
    expect(lines.at(-1)).toContain("FOOTER");
  });

  it("renders with no header and/or no footer", () => {
    const noFooter = render(
      <FullscreenLayout header={<Text>ONLYHEAD</Text>}>
        <Text>body</Text>
      </FullscreenLayout>,
    );
    expect(noFooter.lastFrame()).toContain("ONLYHEAD");
    expect(noFooter.lastFrame()).toContain("body");

    const noChrome = render(
      <FullscreenLayout>
        <Text>barebody</Text>
      </FullscreenLayout>,
    );
    expect(noChrome.lastFrame()).toContain("barebody");
  });

  it("provides the measured body size to children via context", () => {
    const { lastFrame } = render(
      <FullscreenLayout header={<Text>H</Text>} footer={<Text>F</Text>}>
        <MeasuredBody />
      </FullscreenLayout>,
    );
    // 24 rows − 1 header − 1 footer = 22 measured body rows (width is the
    // Render harness's terminal width, asserted only as a positive number).
    expect(lastFrame()).toMatch(/MEASURED 22x\d+/);
  });
});
