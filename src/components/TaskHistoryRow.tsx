import { relativeTime } from "#src/lib/relativeTime.js";
import type { TaskRunRecord } from "./TaskRunRecord.js";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";

const SPINNER_FRAMES = ["◐", "◑", "◒", "◓"];
const SPINNER_INTERVAL = 150;

interface TaskHistoryRowProps {
  record: TaskRunRecord;
}

export function TaskHistoryRow({ record }: TaskHistoryRowProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (record.result !== "running") {
      return;
    }
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL);
    return () => {
      clearInterval(id);
    };
  }, [record.result]);

  if (record.result === "running") {
    return (
      <Box gap={1}>
        <Text color="yellow">{SPINNER_FRAMES[frame]}</Text>
        <Text>{record.taskName}</Text>
        <Text dimColor>running…</Text>
      </Box>
    );
  }

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
