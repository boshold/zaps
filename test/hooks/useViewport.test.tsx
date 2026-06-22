import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

// Shared stdout stub so the composed useDimensions sees a fixed terminal size.
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

const { useViewport } = await import("../../src/hooks/useViewport.js");

function Probe({ estimatedChrome }: { estimatedChrome?: number }) {
  const { ref, height, width } = useViewport([], estimatedChrome);
  return (
    <Box flexDirection="column" height={24} width={80}>
      <Text>header</Text>
      <Box ref={ref} flexGrow={1}>
        <Text>{`H:${height} W:${width}`}</Text>
      </Box>
      <Text>footer</Text>
    </Box>
  );
}

describe("useViewport", () => {
  it("settles height to the measured body rows after a tick", () => {
    // 24 total − 1 header − 1 footer = 22 measured body rows.
    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toContain("H:22");
    expect(lastFrame()).toContain("W:80");
  });

  it("never paints a blank/zero body — first frame uses the rows−chrome fallback", () => {
    const { frames } = render(<Probe estimatedChrome={4} />);
    // Fallback for the first tick: 24 − 4 = 20, never 0.
    expect(frames[0]).toContain("H:20");
    for (const frame of frames) {
      expect(frame).not.toContain("H:0 ");
    }
  });
});
