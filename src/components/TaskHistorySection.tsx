import type { TaskRunRecord } from "./TaskRunRecord.js";
import { Box, Text } from "ink";

import { TaskHistoryRow } from "./TaskHistoryRow.js";

interface TaskHistorySectionProps {
  title: string;
  history: TaskRunRecord[];
  limit: number;
}

export function TaskHistorySection({ title, history, limit }: TaskHistorySectionProps) {
  if (history.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold dimColor>
        {title}
      </Text>
      {history.slice(0, limit).map((record) => (
        <TaskHistoryRow key={`${record.taskKey}-${String(record.timestamp)}`} record={record} />
      ))}
    </Box>
  );
}
