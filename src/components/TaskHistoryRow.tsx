import { Text } from "ink";
import { useEffect, useState } from "react";

import { relativeTime } from "#src/lib/relativeTime.js";

import type { TaskRunRecord } from "./TaskRunRecord.js";
import { useIcons } from "./theme/IconTheme.js";

const SPINNER_INTERVAL = 150;

interface TaskHistoryRowProps {
  record: TaskRunRecord;
  maxWidth?: number;
}

function truncate(str: string, max: number, ellipsis: string): string {
  if (str.length <= max) {
    return str;
  }
  return `${str.slice(0, Math.max(0, max - ellipsis.length))}${ellipsis}`;
}

export function TaskHistoryRow({ record, maxWidth }: TaskHistoryRowProps) {
  const { icon, spinnerFrames } = useIcons();
  const ellipsis = icon("ellipsis");
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (record.result !== "running") {
      return;
    }
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % spinnerFrames.length);
    }, SPINNER_INTERVAL);
    return () => {
      clearInterval(id);
    };
  }, [record.result, spinnerFrames.length]);

  if (record.result === "running") {
    const spinner = spinnerFrames[frame % spinnerFrames.length];
    const suffix = ` running${ellipsis}`;
    // Icon(1) + space(1) + name + space(1) + suffix
    const full = `${spinner} ${record.taskName}${suffix}`;
    const display = maxWidth !== undefined ? truncate(full, maxWidth, ellipsis) : full;
    return (
      <Text>
        <Text color="yellow">{display.slice(0, 1)}</Text>
        <Text>{display.slice(1)}</Text>
      </Text>
    );
  }

  const resultIcon = record.result === "success" ? icon("taskSuccess") : icon("taskError");
  const iconColor = record.result === "success" ? "green" : "red";
  const time = ` ${relativeTime(record.timestamp)}`;
  const full = `${resultIcon} ${record.taskName}${time}`;
  const display = maxWidth !== undefined ? truncate(full, maxWidth, ellipsis) : full;

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
