import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";

import { expect, it } from "vitest";
import { z } from "zod";

import { DaemonClient } from "../../src/client/daemon-client.js";
import { makeSessionSnapshot } from "../_helpers/session-snapshot.js";

const requestSchema = z.object({
  id: z.string(),
  method: z.string(),
});

it.each([
  { event: "task.start", data: { key: "build", name: "Build", runId: "run-1" }, bound: true },
  { event: "session.destroyed", data: {}, bound: false },
])(
  "handles $event after the attach ACK in the same socket write",
  async ({ event, data, bound }) => {
    const dir = await mkdtemp("/tmp/zaps-ui-ack-");
    const socketPath = path.join(dir, "daemon.sock");
    const snapshot = makeSessionSnapshot();
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      const lines = createInterface({ input: socket });
      lines.on("line", (line) => {
        const request = requestSchema.parse(JSON.parse(line));
        if (request.method === "daemon.status") {
          socket.write(
            `${JSON.stringify({ id: request.id, result: { pid: 1, sessions: [], supportedBackends: ["tmux"] } })}\n`,
          );
        } else if (request.method === "subscribe") {
          socket.write(`${JSON.stringify({ id: request.id, result: { subscribed: true } })}\n`);
        } else if (request.method === "session.attach") {
          const ack = JSON.stringify({ id: request.id, result: snapshot });
          const liveEvent = JSON.stringify({ event, session: snapshot.id, data });
          socket.write(`${ack}\n${liveEvent}\n`);
        }
      });
    });
    const client = new DaemonClient(socketPath, snapshot.id);
    const order: string[] = [];
    client.on("session.snapshot", () => order.push("snapshot"));
    client.on(event, () => order.push(event));
    try {
      server.listen(socketPath);
      await once(server, "listening");
      const attach = client.connectUi();
      await (bound
        ? expect(attach).resolves.toEqual(snapshot)
        : expect(attach).rejects.toThrow("daemon connection closed"));
      expect(order).toEqual(["snapshot", event]);
      expect(client.uiBound).toBe(bound);
    } finally {
      client.disconnect();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
