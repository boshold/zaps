import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { CommandPaletteBody } from "../../../src/components/overlay/CommandPaletteBody.js";
import type { Command } from "../../../src/lib/command-registry.js";

// CommandPalette itself wraps the body in a position="absolute" box, which
// Ink-testing-library can't capture (see DockerRebuildView.test). The body holds
// All behavior and is absolute-free, so it is tested directly here.

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 25));
};

function makeCommands(runSpy = vi.fn()): Command[] {
  return [
    { id: "a", title: "Restart all services", group: "global", run: vi.fn() },
    { id: "b", title: "Reload config", group: "global", run: runSpy },
    { id: "c", title: "Shut down session", group: "global", run: vi.fn() },
  ];
}

async function type(stdin: { write: (s: string) => void }, text: string) {
  for (const ch of text) {
    stdin.write(ch);
    // Flush between keystrokes so each lands against a committed render.
    await flush();
  }
}

describe("CommandPaletteBody", () => {
  it("renders the full registry on open (empty query)", () => {
    const { lastFrame } = render(
      <CommandPaletteBody commands={makeCommands()} isActive onClose={() => undefined} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Restart all services");
    expect(frame).toContain("Reload config");
    expect(frame).toContain("Type a command");
  });

  it("fuzzy-filters the list as the user types", async () => {
    const { stdin, lastFrame } = render(
      <CommandPaletteBody commands={makeCommands()} isActive onClose={() => undefined} />,
    );
    await type(stdin, "reload");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Reload config");
    expect(frame).not.toContain("Restart all services");
    expect(frame).not.toContain("Shut down session");
  });

  it("shows an empty-state message when nothing matches", async () => {
    const { stdin, lastFrame } = render(
      <CommandPaletteBody commands={makeCommands()} isActive onClose={() => undefined} />,
    );
    await type(stdin, "zzzzz");
    expect(lastFrame() ?? "").toContain("No matching commands");
  });

  it("runs the highlighted command on Enter and closes", async () => {
    const runSpy = vi.fn();
    const onClose = vi.fn();
    const { stdin } = render(
      <CommandPaletteBody commands={makeCommands(runSpy)} isActive onClose={onClose} />,
    );
    await type(stdin, "reload");
    stdin.write("\r");
    await flush();
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not run or close when nothing matches", async () => {
    const runSpy = vi.fn();
    const onClose = vi.fn();
    const { stdin } = render(
      <CommandPaletteBody commands={makeCommands(runSpy)} isActive onClose={onClose} />,
    );
    await type(stdin, "zzzzz");
    stdin.write("\r");
    await flush();
    expect(runSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not bind Esc (OverlayHost owns Esc→pop, so no double-pop)", async () => {
    const onClose = vi.fn();
    const { stdin } = render(
      <CommandPaletteBody commands={makeCommands()} isActive onClose={onClose} />,
    );
    stdin.write("\x1B"); // Esc
    await flush();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores input while inactive", async () => {
    const runSpy = vi.fn();
    const onClose = vi.fn();
    const { stdin, lastFrame } = render(
      <CommandPaletteBody commands={makeCommands(runSpy)} isActive={false} onClose={onClose} />,
    );
    await type(stdin, "reload");
    stdin.write("\r");
    await flush();
    // No filtering happened and Enter did nothing.
    expect(lastFrame() ?? "").toContain("Restart all services");
    expect(runSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
