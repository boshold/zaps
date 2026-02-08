import { useState } from "react";

export type View = "dashboard" | "tasks" | "logs";

export function useRouter() {
  const [view, setView] = useState<View>("dashboard");
  const [logTarget, setLogTarget] = useState<string | null>(null);

  function goToLogs(serviceName: string) {
    setLogTarget(serviceName);
    setView("logs");
  }

  function goToDashboard() {
    setView("dashboard");
  }

  function goToTasks() {
    setView("tasks");
  }

  return { view, logTarget, goToLogs, goToDashboard, goToTasks };
}
