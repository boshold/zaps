import fs from "node:fs";
import net from "node:net";

import type { ResolvedConfig } from "#src/config/types.js";
import type { ServiceManager } from "#src/lib/service/manager.js";

import { handleRequest } from "./handler.js";
import type { IpcRequest } from "./protocol.js";

export class IpcServer {
  private server: net.Server | null = null;
  private readonly socketPath: string;
  private readonly manager: ServiceManager;
  private readonly config: ResolvedConfig;

  public constructor(socketPath: string, manager: ServiceManager, config: ResolvedConfig) {
    this.socketPath = socketPath;
    this.manager = manager;
    this.config = config;
  }

  public async start(): Promise<void> {
    // Clean up stale socket file
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // File doesn't exist — fine
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        let buffer = "";

        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          // Keep incomplete last line in buffer
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.trim() !== "") {
              void this.handleLine(line, socket);
            }
          }
        });

        socket.on("error", () => {
          // Client disconnected — ignore
        });
      });

      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => {
        resolve();
      });
    });
  }

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let req: IpcRequest = { id: "?", method: "" };
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      socket.write(`${JSON.stringify({ id: "?", error: "Invalid JSON" })}\n`);
      return;
    }

    const response = await handleRequest(req, this.manager, this.config, socket);
    socket.write(`${JSON.stringify(response)}\n`);
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Already gone
    }
  }
}
