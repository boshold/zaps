import { Box, Text } from "ink";

interface EmptyStateProps {
  message: string;
  hint?: string;
}

/**
 * Centered placeholder for empty/loading body states (no-services, loading,
 * no-tasks, empty-filter). Fills the measured body and centers its text so the
 * pane is never a bare blank.
 */
export function EmptyState({ message, hint }: EmptyStateProps) {
  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      <Box flexDirection="column" alignItems="center">
        <Text dimColor>{message}</Text>
        {hint ? <Text dimColor>{hint}</Text> : null}
      </Box>
    </Box>
  );
}
