import { useState } from "react";

export type View = "dashboard" | "logs";

export function useRouter() {
  const [view, setView] = useState<View>("dashboard");
  const [logTarget, setLogTarget] = useState<string | null>(null);

  function goToLogs(serviceName: string) {
    setLogTarget(serviceName);
    setView("logs");
  }

  function goToDashboard() {
    // Clear the log target so useLogs unsubscribes and stops accumulating lines in the background once we leave the log view (F1).
    setLogTarget(null);
    setView("dashboard");
  }

  return {
    view,
    logTarget,
    goToLogs,
    goToDashboard,
  };
}
