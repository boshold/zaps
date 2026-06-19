import { Text } from "ink";

import { ScrollableList } from "./layout/ScrollableList.js";
import { useViewportSize } from "./layout/ViewportContext.js";

interface LogViewBodyProps {
  lines: string[];
  autoScroll: boolean;
  offset: number;
}

/**
 * The scrollable log body, windowed to the measured viewport height (read from
 * `FullscreenLayout`) instead of a hardcoded `rows - 4`. The newest visible line
 * — the tail when autoscrolling, or `offset` lines back when scrolled — is
 * anchored at the bottom by slicing off newer lines and selecting the last one,
 * so `ScrollableList` grows older lines upward and emits an up-overflow marker.
 */
export function LogViewBody({ lines, autoScroll, offset }: LogViewBodyProps) {
  const { height } = useViewportSize();
  const anchor = autoScroll ? lines.length - 1 : lines.length - 1 - offset;
  const visibleSource = lines.slice(0, Math.max(0, anchor + 1));

  return (
    <ScrollableList
      items={visibleSource}
      selectedIndex={visibleSource.length - 1}
      maxHeight={height}
      renderItem={(line, index) => (
        // eslint-disable-next-line react/no-array-index-key -- log lines have no stable key
        <Text key={index} wrap="truncate">
          {line}
        </Text>
      )}
    />
  );
}
