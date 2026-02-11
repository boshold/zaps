import { useState } from "react";

export type View = "dashboard" | "tasks" | "logs" | "task-chord";

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

  function goToTaskChord() {
    setView("task-chord");
  }

  return { view, logTarget, goToLogs, goToDashboard, goToTasks, goToTaskChord };
}
