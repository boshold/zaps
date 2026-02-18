import { randomUUID } from "node:crypto";

import { killSession, newSession, splitPane } from "#src/lib/tmux.js";

export interface TestSession {
  name: string;
  initialPaneId: string;
  cleanup: () => Promise<void>;
}

export async function createTestSession(): Promise<TestSession> {
  const name = `zaps-test-${randomUUID().slice(0, 8)}`;
  const initialPaneId = await newSession(name);
  return {
    name,
    initialPaneId,
    async cleanup() {
      try {
        await killSession(name);
      } catch {
        // Session may already be gone
      }
    },
  };
}

export async function buildTestPaneMap(
  initialPaneId: string,
  serviceNames: string[],
): Promise<Record<string, string>> {
  const paneMap: Record<string, string> = { "@tui": initialPaneId };
  for (const name of serviceNames) {
    // eslint-disable-next-line no-await-in-loop -- Sequential tmux operations
    const paneId = await splitPane(initialPaneId, "v");
    paneMap[name] = paneId;
  }
  return paneMap;
}
