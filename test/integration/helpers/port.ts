import net from "node:net";

async function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Reserve a port and hold it until explicitly released.
 * Prevents port races between allocation and actual use.
 */
export async function reservePort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) {
        resolve({
          port: addr.port,
          release: async () => closeServer(server),
        });
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
    server.on("error", reject);
  });
}

/**
 * Get a free port. The port is released immediately — use `reservePort()`
 * when you need to hold it until the service binds.
 */
export async function getFreePort(): Promise<number> {
  const { port, release } = await reservePort();
  await release();
  return port;
}
