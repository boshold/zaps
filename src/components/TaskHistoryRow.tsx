import { relativeTime } from "#src/lib/relativeTime.js";
import { Text } from "ink";
import { useEffect, useState } from "react";

import type { TaskRunRecord } from "./TaskRunRecord.js";

const SPINNER_FRAMES = ["◐", "◑", "◒", "◓"];
const SPINNER_INTERVAL = 150;

interface TaskHistoryRowProps {
  record: TaskRunRecord;
  maxWidth?: number;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) {
    return str;
  }
  return `${str.slice(0, max - 1)}…`;
}

export function TaskHistoryRow({ record, maxWidth }: TaskHistoryRowProps) {
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
    const icon = SPINNER_FRAMES[frame];
    const suffix = " running…";
    // Icon(1) + space(1) + name + space(1) + suffix
    const full = `${icon} ${record.taskName}${suffix}`;
    const display = maxWidth !== undefined ? truncate(full, maxWidth) : full;
    return (
      <Text>
        <Text color="yellow">{display.slice(0, 1)}</Text>
        <Text>{display.slice(1)}</Text>
      </Text>
    );
  }

  const icon = record.result === "success" ? "✔" : "✖";
  const iconColor = record.result === "success" ? "green" : "red";
  const time = ` ${relativeTime(record.timestamp)}`;
  const full = `${icon} ${record.taskName}${time}`;
  const display = maxWidth !== undefined ? truncate(full, maxWidth) : full;

  // Split: icon(1), space+name, time suffix
  const nameEnd = 2 + record.taskName.length;
  if (display.length <= 2) {
    return <Text color={iconColor}>{display}</Text>;
  }

  const displayTime = display.length > nameEnd ? display.slice(nameEnd) : "";
  const displayName = display.slice(2, Math.min(display.length, nameEnd));

  return (
    <Text>
      <Text color={iconColor}>{display.slice(0, 1)}</Text>
      <Text> {displayName}</Text>
      {displayTime && <Text dimColor>{displayTime}</Text>}
    </Text>
  );
}
