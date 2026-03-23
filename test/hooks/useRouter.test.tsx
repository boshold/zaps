import { Text } from "ink";
import { render } from "ink-testing-library";
import { act } from "react";
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
    act(() => {
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
    act(() => {
      hookRef!.goToLogs("db");
    });
    expect(lastFrame()).toContain("view:logs");

    // Go back to dashboard
    act(() => {
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

    act(() => {
      hookRef!.goToTasks();
    });
    expect(lastFrame()).toContain("view:tasks");
  });

  it("goToDockerRebuild sets view and dockerRebuildTarget", async () => {
    let hookRef: ReturnType<typeof useRouter> | null = null;

    function Wrapper() {
      hookRef = useRouter();
      return (
        <>
          <Text>view:{hookRef.view}</Text>
          <Text>target:{hookRef.dockerRebuildTarget ?? "null"}</Text>
        </>
      );
    }

    const { lastFrame } = render(<Wrapper />);
    expect(lastFrame()).toContain("target:null");

    act(() => {
      hookRef!.goToDockerRebuild("postgres");
    });
    expect(lastFrame()).toContain("view:dockerRebuild");
    expect(lastFrame()).toContain("target:postgres");
  });
});
