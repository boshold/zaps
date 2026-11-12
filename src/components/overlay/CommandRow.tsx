import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { useIcons } from "#src/components/theme/IconTheme.js";

interface CommandRowProps {
  title: string;
  /** Ascending matched character indexes into `title` (from `fuzzyRank`). */
  indexes: number[];
  /** Optional dimmed trailing hint (url, shortcut). */
  hint?: string;
  /** Optional dimmed text after the title; truncated first on narrow widths. */
  detail?: string;
  selected: boolean;
}

/** Split the title into plain text and highlighted (matched) character spans. */
function renderTitle(title: string, indexes: number[]): ReactNode[] {
  const matched = new Set(indexes);
  return Array.from(title, (char, i) =>
    matched.has(i) ? (
      // eslint-disable-next-line react/no-array-index-key -- char position is the only stable key here
      <Text key={i} color="cyan" bold>
        {char}
      </Text>
    ) : (
      char
    ),
  );
}

/** One palette result row: selection marker, fuzzy-highlighted title, optional hint. */
export function CommandRow({ title, indexes, hint, detail, selected }: CommandRowProps) {
  const { icon } = useIcons();
  const marker = selected ? `${icon("selection")} ` : "  ";

  return (
    <Box>
      <Text color={selected ? "cyan" : undefined}>{marker}</Text>
      <Box flexShrink={0}>
        <Text bold={selected}>{renderTitle(title, indexes)}</Text>
      </Box>
      {detail ? (
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">{`  ${detail}`}</Text>
        </Box>
      ) : null}
      {hint ? (
        <Box flexShrink={0}>
          <Text dimColor>{`  ${hint}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export type { CommandRowProps };
