import { render } from "ink-testing-library";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Spinner, TextInput } from "../../../src/components/input/index.js";

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
};

/** A controlled host so typing flows value → onChange → re-render, like real consumers. */
function ControlledInput({
  initial = "",
  placeholder,
}: {
  initial?: string;
  placeholder?: string;
}) {
  const [value, setValue] = useState(initial);
  return <TextInput value={value} onChange={setValue} placeholder={placeholder} />;
}

describe("input/TextInput", () => {
  it("renders the placeholder when empty", () => {
    const { lastFrame } = render(<ControlledInput placeholder="search…" />);
    expect(lastFrame() ?? "").toContain("search…");
  });

  it("renders the controlled value", () => {
    const { lastFrame } = render(<TextInput value="hello" onChange={() => undefined} />);
    expect(lastFrame() ?? "").toContain("hello");
  });

  it("appends typed characters and reflects the controlled value", async () => {
    const { stdin, lastFrame } = render(<ControlledInput />);
    // Flush between keystrokes so each is delivered against a committed render,
    // As a real terminal does (one data event per render cycle).
    for (const ch of "abc") {
      stdin.write(ch);
      await flush();
    }
    expect(lastFrame() ?? "").toContain("abc");
  });

  it("inserts a multi-character chunk (paste) in one event", async () => {
    const { stdin, lastFrame } = render(<ControlledInput />);
    stdin.write("abc");
    await flush();
    expect(lastFrame() ?? "").toContain("abc");
  });

  it("deletes the previous character on backspace", async () => {
    const { stdin, lastFrame } = render(<ControlledInput initial="" />);
    stdin.write("hi");
    await flush();
    expect(lastFrame() ?? "").toContain("hi");
    stdin.write("\x7f"); // Backspace
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("h");
    expect(frame).not.toContain("hi");
  });

  it("emits onChange with the next value", async () => {
    const onChange = vi.fn();
    const { stdin } = render(<TextInput value="" onChange={onChange} />);
    stdin.write("x");
    await flush();
    expect(onChange).toHaveBeenCalledWith("x");
  });

  it("calls onSubmit with the current value on Enter", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <TextInput value="run" onChange={() => undefined} onSubmit={onSubmit} />,
    );
    stdin.write("\r");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith("run");
  });

  it("ignores keystrokes when inactive", async () => {
    const onChange = vi.fn();
    const { stdin } = render(<TextInput value="" onChange={onChange} isActive={false} />);
    stdin.write("z");
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("input/Spinner", () => {
  it("renders a frame glyph with its label", () => {
    const { lastFrame } = render(<Spinner label="loading" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("loading");
    // The default (nerd) tier's first frame is present.
    expect(frame.trim().length).toBeGreaterThan("loading".length);
  });
});
