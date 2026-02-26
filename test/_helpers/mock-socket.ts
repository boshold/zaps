import { EventEmitter } from "node:events";

import { vi } from "vitest";

export interface MockSocket extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  destroyed: boolean;
}

export function createMockSocket(): MockSocket {
  const emitter = new EventEmitter() as MockSocket;
  emitter.write = vi.fn();
  emitter.destroy = vi.fn(() => {
    emitter.destroyed = true;
    emitter.emit("close");
  });
  emitter.destroyed = false;
  return emitter;
}
