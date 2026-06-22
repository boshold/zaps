import { describe, expect, it, vi } from "vitest";

import { notifyFailure } from "../../src/lib/notifier.js";

const BEL = "\x07";
const osc9Bytes = (msg: string) => `\x1b]9;\n\n${msg}${BEL}`;

describe("notifyFailure", () => {
  it("writes nothing when the channel is off", () => {
    const write = vi.fn();
    notifyFailure("build", "off", write);
    expect(write).not.toHaveBeenCalled();
  });

  it("rings only the bell on the bell channel", () => {
    const write = vi.fn();
    notifyFailure("build", "bell", write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(BEL);
  });

  it("writes the OSC 9 escape on the osc9 channel", () => {
    const write = vi.fn();
    notifyFailure("build", "osc9", write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(osc9Bytes("Task failed: build"));
  });

  it("writes both OSC 9 and the bell on osc9+bell", () => {
    const write = vi.fn();
    notifyFailure("deploy", "osc9+bell", write);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(1, osc9Bytes("Task failed: deploy"));
    expect(write).toHaveBeenNthCalledWith(2, BEL);
  });

  it("emits only the task name, never extra payload", () => {
    const write = vi.fn();
    notifyFailure("migrate-db", "osc9", write);
    const payload = write.mock.calls[0]?.[0] as string;
    expect(payload).toContain("migrate-db");
    expect(payload).toBe(osc9Bytes("Task failed: migrate-db"));
  });

  it("defaults to stdout when no sink is given", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      notifyFailure("build", "bell");
      expect(spy).toHaveBeenCalledWith(BEL);
    } finally {
      spy.mockRestore();
    }
  });
});
