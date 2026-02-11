import type { ServiceStatus } from "#src/lib/service/types.js";

import { StatusIndicator } from "./StatusIndicator.js";

export function StatusCell({ status }: { status: ServiceStatus }) {
  return <StatusIndicator state={status.state} />;
}
