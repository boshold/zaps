import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToastApi } from "../../src/hooks/useToasts.js";
import { ToastProvider, useToasts } from "../../src/hooks/useToasts.js";

let captured: ToastApi | undefined;

function Probe() {
  captured = useToasts();
  return <Text>count:{captured.toasts.length}</Text>;
}

function renderProvider(ttlMs?: number) {
  return render(
    <ToastProvider ttlMs={ttlMs}>
      <Probe />
    </ToastProvider>,
  );
}

describe("useToasts", () => {
  beforeEach(() => {
    captured = undefined;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("returns an inert API with no provider", () => {
    render(<Probe />);
    expect(captured?.toasts).toHaveLength(0);
    // No-op notify must not throw and must not enqueue anything.
    act(() => {
      captured?.notify({ level: "success", message: "x", runId: null, sticky: false });
    });
    expect(captured?.toasts).toHaveLength(0);
  });

  it("notify enqueues a toast and returns its id", () => {
    renderProvider();
    let id = "";
    act(() => {
      id = captured?.notify({ level: "info", message: "hello", runId: null, sticky: false }) ?? "";
    });
    expect(id).not.toBe("");
    expect(captured?.toasts).toHaveLength(1);
    expect(captured?.toasts[0]).toMatchObject({ level: "info", message: "hello", sticky: false });
    expect(captured?.toasts[0]?.createdAt).toBeTypeOf("number");
  });

  it("auto-dismisses an info/success toast after the interval", () => {
    renderProvider(3000);
    act(() => {
      captured?.notify({ level: "success", message: "done", runId: null, sticky: false });
    });
    expect(captured?.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(captured?.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(captured?.toasts).toHaveLength(0);
  });

  it("keeps an error toast sticky until acknowledged", () => {
    renderProvider(3000);
    act(() => {
      captured?.notify({ level: "error", message: "boom", runId: "run_1", sticky: false });
    });
    // Error is forced sticky regardless of the caller's flag.
    expect(captured?.toasts[0]?.sticky).toBe(true);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(captured?.toasts).toHaveLength(1);

    act(() => {
      captured?.ackAll();
    });
    expect(captured?.toasts).toHaveLength(0);
  });

  it("ackAll clears sticky failures but leaves transient toasts in place", () => {
    renderProvider(3000);
    act(() => {
      captured?.notify({ level: "success", message: "ok", runId: null, sticky: false });
      captured?.notify({ level: "error", message: "fail", runId: "r2", sticky: true });
    });
    expect(captured?.toasts).toHaveLength(2);

    act(() => {
      captured?.ackAll();
    });
    expect(captured?.toasts).toHaveLength(1);
    expect(captured?.toasts[0]?.level).toBe("success");
  });

  it("dismiss removes a specific toast and cancels its timer", () => {
    renderProvider(3000);
    let id = "";
    act(() => {
      id = captured?.notify({ level: "info", message: "a", runId: null, sticky: false }) ?? "";
    });
    act(() => {
      captured?.dismiss(id);
    });
    expect(captured?.toasts).toHaveLength(0);
    // Advancing past the TTL must not fire a stale timer or throw.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(captured?.toasts).toHaveLength(0);
  });

  it("carries runId so a failure toast can open its output", () => {
    renderProvider();
    act(() => {
      captured?.notify({ level: "error", message: "fail", runId: "run_42", sticky: true });
    });
    expect(captured?.toasts[0]?.runId).toBe("run_42");
  });
});
