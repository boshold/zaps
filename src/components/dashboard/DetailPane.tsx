import { Box, Text } from "ink";

import { useIcons } from "#src/components/theme/IconTheme.js";
import type { ServiceStatus } from "#src/lib/service/types.js";

import { DetailField } from "./DetailField.js";

interface DetailPaneProps {
  status?: ServiceStatus;
  width: number;
  /**
   * Advisory row budget for the whole pane. Fields past it collapse into a
   * trailing "+N more" line so a cramped terminal degrades gracefully instead of
   * letting the content overflow (the body's `overflowY` would otherwise clip it
   * mid-field). Omit for an unbounded render.
   */
  maxLines?: number;
}

interface Field {
  label: string;
  value: string;
  color?: string;
}

function formatUptime(readySince: number | undefined): string {
  if (typeof readySince !== "number") {
    return "n/a";
  }
  const diff = Math.floor((Date.now() - readySince) / 1000);
  if (diff < 60) {
    return `${diff}s`;
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)}m`;
  }
  const hours = Math.floor(diff / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Fields in priority order — when the pane is too short for all of them, the
 * tail is dropped first. `error` ranks high (right after `state`) so a failure
 * is never the field that gets hidden.
 */
function detailFields(status: ServiceStatus, dockerYes: string): Field[] {
  const fields: Field[] = [{ label: "state", value: status.state }];
  if (status.lastError) {
    fields.push({ label: "error", value: status.lastError, color: "red" });
  }
  fields.push(
    { label: "url", value: status.url ?? "n/a" },
    {
      label: "ports",
      value: status.ports.length > 0 ? status.ports.map((p) => `:${p}`).join(" ") : "n/a",
    },
    { label: "uptime", value: formatUptime(status.readySince) },
    { label: "pid", value: typeof status.pid === "number" ? String(status.pid) : "n/a" },
    { label: "docker", value: status.isDocker ? dockerYes : "no" },
    { label: "retries", value: String(status.retryCount) },
  );
  if (status.group) {
    fields.push({ label: "group", value: status.group });
  }
  return fields;
}

/**
 * Right-hand detail pane for the selected service, shown only on wide terminals
 * (`cols >= ui.wideThreshold`). Renders the available `ServiceStatus` fields,
 * gracefully showing `n/a` for anything absent.
 *
 * No border or fixed height of its own — the full-height pane divider lives in
 * the layout beside it ({@link DashboardSplit}). Constraining a bordered flex
 * column to a height shorter than its content made Yoga shrink/overlap the rows
 * (garbled "ev"/"n/a2m"); letting the content size naturally and budgeting the
 * field count avoids that entirely.
 */
export function DetailPane({ status, width, maxLines }: DetailPaneProps) {
  const { icon } = useIcons();

  if (!status) {
    return (
      <Box width={width} flexDirection="column" paddingLeft={1}>
        <Text dimColor>No service selected</Text>
      </Box>
    );
  }

  const allFields = detailFields(status, `${icon("docker")} yes`);
  // 1 line for the bold name + 1 blank spacer are fixed; the rest of the budget
  // Is for fields. When they don't all fit, drop the tail and reserve a row for
  // The "+N more" marker.
  const fieldBudget = typeof maxLines === "number" ? Math.max(1, maxLines - 2) : allFields.length;
  const truncated = allFields.length > fieldBudget;
  const shown = truncated ? allFields.slice(0, Math.max(0, fieldBudget - 1)) : allFields;
  const hidden = allFields.length - shown.length;

  return (
    <Box width={width} flexDirection="column" paddingLeft={1}>
      <Text bold>{status.name}</Text>
      <Text> </Text>
      {shown.map((f) => (
        <DetailField key={f.label} label={f.label} value={f.value} color={f.color} />
      ))}
      {truncated && (
        <Text dimColor>
          {icon("ellipsis")} +{hidden} more
        </Text>
      )}
    </Box>
  );
}
