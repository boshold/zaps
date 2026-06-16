import { useState } from "react";

export type View = "dashboard" | "tasks" | "logs" | "dockerRebuild";

export function useRouter() {
  const [view, setView] = useState<View>("dashboard");
  const [logTarget, setLogTarget] = useState<string | null>(null);
  const [dockerRebuildTarget, setDockerRebuildTarget] = useState<string | null>(null);

  function goToLogs(serviceName: string) {
    setLogTarget(serviceName);
    setView("logs");
  }

  function goToDashboard() {
    // Clear the log target so useLogs unsubscribes and stops accumulating lines in the background once we leave the log view (F1).
    setLogTarget(null);
    setView("dashboard");
  }

  function goToTasks() {
    setView("tasks");
  }

  function goToDockerRebuild(serviceName: string) {
    setDockerRebuildTarget(serviceName);
    setView("dockerRebuild");
  }

  return {
    view,
    logTarget,
    dockerRebuildTarget,
    goToLogs,
    goToDashboard,
    goToTasks,
    goToDockerRebuild,
  };
}
