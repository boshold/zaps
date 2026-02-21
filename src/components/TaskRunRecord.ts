export interface TaskRunRecord {
  taskKey: string;
  taskName: string;
  result: "success" | "error" | "running";
  timestamp: number;
}
