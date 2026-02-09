import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { useRouter } from "../../src/hooks/useRouter.js";

// Helper: renders hook in a minimal component and returns getters/actions
function renderRouter() {
  let hookRef: ReturnType<typeof useRouter> | null = null;

  function Wrapper() {
    hookRef = useRouter();
    return (
      <>
        <Text>view:{hookRef.view}</Text>
        <Text>logTarget:{hookRef.logTarget ?? "null"}</Text>
      </>
    );
  }

  const { lastFrame, rerender } = render(<Wrapper />);
  return {
    lastFrame,
    rerender: () => rerender(<Wrapper />),
    get hook() {
      return hookRef!;
    },
  };
}

describe("useRouter", () => {
  it("default view is dashboard", () => {
    const { lastFrame } = renderRouter();
    expect(lastFrame()).toContain("view:dashboard");
    expect(lastFrame()).toContain("logTarget:null");
  });

  it("goToLogs sets view and logTarget", async () => {
    let hookRef: ReturnType<typeof useRouter> | null = null;

    function Wrapper() {
      hookRef = useRouter();
      return (
        <>
          <Text>view:{hookRef.view}</Text>
          <Text>logTarget:{hookRef.logTarget ?? "null"}</Text>
        </>
      );
    }

    const { lastFrame } = render(<Wrapper />);
    expect(lastFrame()).toContain("view:dashboard");

    // Call goToLogs via the hook ref
    await act(() => {
      hookRef!.goToLogs("api");
    });

    expect(lastFrame()).toContain("view:logs");
    expect(lastFrame()).toContain("logTarget:api");
  });

  it("goToDashboard resets view", async () => {
    let hookRef: ReturnType<typeof useRouter> | null = null;

    function Wrapper() {
      hookRef = useRouter();
      return (
        <>
          <Text>view:{hookRef.view}</Text>
          <Text>logTarget:{hookRef.logTarget ?? "null"}</Text>
        </>
      );
    }

    const { lastFrame } = render(<Wrapper />);

    // Go to logs first
    await act(() => {
      hookRef!.goToLogs("db");
    });
    expect(lastFrame()).toContain("view:logs");

    // Go back to dashboard
    await act(() => {
      hookRef!.goToDashboard();
    });
    expect(lastFrame()).toContain("view:dashboard");
  });

  it("goToTasks sets view to tasks", async () => {
    let hookRef: ReturnType<typeof useRouter> | null = null;

    function Wrapper() {
      hookRef = useRouter();
      return <Text>view:{hookRef.view}</Text>;
    }

    const { lastFrame } = render(<Wrapper />);

    await act(() => {
      hookRef!.goToTasks();
    });
    expect(lastFrame()).toContain("view:tasks");
  });
});

// Minimal act() for Ink — triggers React batch update
function act(fn: () => void): Promise<void> {
  return new Promise((resolve) => {
    fn();
    setTimeout(resolve, 0);
  });
}
