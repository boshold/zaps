import { EventEmitter } from "node:events";

import { vi } from "vitest";

import type { ServiceManager } from "../../src/lib/service/manager.js";

export function createMockServiceManager(): ServiceManager {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    startAll: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    startService: vi.fn().mockResolvedValue({ noop: false }),
    stopService: vi.fn().mockResolvedValue({ noop: false }),
    restartService: vi.fn().mockResolvedValue(undefined),
    getAllStatuses: vi.fn(() => [{ name: "api", state: "ready", ports: [3000], retryCount: 0 }]),
    getStatus: vi.fn((name: string) => {
      if (name === "api") {
        return { name: "api", state: "ready", ports: [3000], retryCount: 0 };
      }
      throw new Error(`Unknown service: ${name}`);
    }),
  }) as unknown as ServiceManager;
}
