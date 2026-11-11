import type { IpcResponse } from "../../src/lib/ipc/protocol.js";

type RequestArgs = [
  method: string,
  params?: unknown,
  timeoutMs?: number,
  accept?: (response: IpcResponse) => unknown,
];

export function acceptMockResponse(respond: (...args: RequestArgs) => Promise<IpcResponse>) {
  return async (...args: RequestArgs) => {
    const response = await respond(...args);
    return args[3] ? args[3](response) : response;
  };
}
