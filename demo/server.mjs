import { createServer } from "node:http";

const [name, portValue] = process.argv.slice(2);
const port = Number.parseInt(portValue ?? "", 10);

if (!name || !Number.isInteger(port)) {
  throw new Error("Usage: node server.mjs <name> <port>");
}

let requestCount = 0;
const server = createServer((request, response) => {
  requestCount += 1;
  response.writeHead(request.url === "/health" ? 200 : 404, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ service: name, request: requestCount }));
  process.stdout.write(`[${name}] ${request.method} ${request.url}\n`);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`[${name}] ready at http://127.0.0.1:${port}\n`);
});

const heartbeat = setInterval(() => {
  process.stdout.write(`[${name}] heartbeat ${new Date().toISOString().slice(11, 19)}\n`);
}, 1000);

function shutdown() {
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
