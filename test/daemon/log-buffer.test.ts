import { describe, expect, it } from "vitest";

import { LogBuffer } from "../../src/daemon/log-buffer.js";

describe("LogBuffer", () => {
  it("starts empty", () => {
    const buf = new LogBuffer();
    expect(buf.snapshot()).toEqual([]);
    expect(buf.length).toBe(0);
  });

  it("appends and snapshots lines", () => {
    const buf = new LogBuffer();
    buf.append("line1");
    buf.append("line2");
    expect(buf.snapshot()).toEqual(["line1", "line2"]);
    expect(buf.length).toBe(2);
  });

  it("appendLines adds multiple lines at once", () => {
    const buf = new LogBuffer();
    buf.appendLines(["a", "b", "c"]);
    expect(buf.snapshot()).toEqual(["a", "b", "c"]);
    expect(buf.length).toBe(3);
  });

  it("snapshot returns lines in insertion order", () => {
    const buf = new LogBuffer();
    for (let i = 0; i < 5; i += 1) {
      buf.append(`line${i}`);
    }
    expect(buf.snapshot()).toEqual(["line0", "line1", "line2", "line3", "line4"]);
  });

  it("wraps around at capacity", () => {
    const buf = new LogBuffer(3);
    buf.append("a");
    buf.append("b");
    buf.append("c");
    buf.append("d"); // Overwrites "a"

    expect(buf.length).toBe(3);
    const snap = buf.snapshot();
    expect(snap).toEqual(["b", "c", "d"]);
  });

  it("handles multiple wraps", () => {
    const buf = new LogBuffer(2);
    buf.append("1");
    buf.append("2");
    buf.append("3");
    buf.append("4");
    buf.append("5");

    expect(buf.length).toBe(2);
    expect(buf.snapshot()).toEqual(["4", "5"]);
  });

  it("clear resets buffer", () => {
    const buf = new LogBuffer();
    buf.appendLines(["a", "b", "c"]);
    expect(buf.length).toBe(3);

    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.snapshot()).toEqual([]);
  });

  it("works after clear and re-append", () => {
    const buf = new LogBuffer(3);
    buf.appendLines(["a", "b", "c"]);
    buf.clear();
    buf.append("x");
    expect(buf.snapshot()).toEqual(["x"]);
  });

  it("custom capacity respected", () => {
    const buf = new LogBuffer(5);
    for (let i = 0; i < 10; i += 1) {
      buf.append(`line${i}`);
    }
    expect(buf.length).toBe(5);
    expect(buf.snapshot()).toEqual(["line5", "line6", "line7", "line8", "line9"]);
  });

  it("default capacity is 10000", () => {
    const buf = new LogBuffer();
    // Just verify it can hold many lines without wrapping early
    for (let i = 0; i < 100; i += 1) {
      buf.append(`line${i}`);
    }
    expect(buf.length).toBe(100);
    expect(buf.snapshot().length).toBe(100);
  });
});
