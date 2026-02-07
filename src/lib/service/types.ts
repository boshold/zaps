export type ServiceState = "stopped" | "starting" | "ready" | "stopping" | "error" | "restarting";

export interface ServiceStatus {
  name: string;
  state: ServiceState;
  ports: number[];
  url?: string;
  paneId?: string;
  pid?: number;
  retryCount: number;
  lastError?: string;
}
