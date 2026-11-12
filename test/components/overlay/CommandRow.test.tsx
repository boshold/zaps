import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { CommandRow } from "../../../src/components/overlay/CommandRow.js";

const WIDTH = 24;
const title = "Open web in group frontend";
const hint = "http://localhost:3000";

function renderRow(props: { detail?: string; hint?: string; selected?: boolean }) {
  const { lastFrame } = render(
    <Box width={WIDTH} borderStyle="round" flexDirection="column">
      <CommandRow
        title={title}
        indexes={[0, 1]}
        hint={props.hint}
        detail={props.detail}
        selected={props.selected ?? false}
      />
    </Box>,
  );
  return (lastFrame() ?? "").split("\n");
}

describe("CommandRow", () => {
  it.each([
    { label: "hint only", hint },
    { label: "hint and detail", hint, detail: "needs mailhog, api" },
    { label: "detail only", detail: "needs mailhog, api" },
    { label: "selected with hint and detail", hint, detail: "needs db", selected: true },
  ])("keeps a long row within a narrow width ($label)", (props) => {
    const lines = renderRow(props);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(WIDTH);
    }
    expect(lines[1]).toMatch(/│$/);
    expect(lines[1]).toContain("Open");
  });

  it("collapses the detail before the title and hint", () => {
    const { lastFrame } = render(
      <Box width={34} flexDirection="column">
        <CommandRow
          title="Verify mail"
          indexes={[]}
          hint="v"
          detail="needs mailhog, api, db"
          selected={false}
        />
      </Box>,
    );
    const line = lastFrame() ?? "";
    expect(line).toContain("Verify mail");
    expect(line).toContain("…");
    expect(line.trimEnd().endsWith("v")).toBe(true);
  });

  it("renders title, detail and hint in full when there is room", () => {
    const { lastFrame } = render(
      <Box width={80} flexDirection="column">
        <CommandRow
          title="Verify mail"
          indexes={[]}
          hint="v"
          detail="needs mailhog"
          selected={false}
        />
      </Box>,
    );
    expect(lastFrame()).toMatch(/Verify mail\s+needs mailhog\s+v/);
  });
});
