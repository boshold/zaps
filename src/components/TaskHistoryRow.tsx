import { relativeTime } from "#src/lib/relativeTime.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";
import { Box, Text } from "ink";

interface TaskHistoryRowProps {
  record: TaskRunRecord;
}

export function TaskHistoryRow({ record }: TaskHistoryRowProps) {
  return (
    <Box gap={1}>
      <Text color={record.result === "success" ? "green" : "red"}>
        {record.result === "success" ? "✔" : "✖"}
      </Text>
      <Text>{record.taskName}</Text>
      <Text dimColor>{relativeTime(record.timestamp)}</Text>
    </Box>
  );
}
