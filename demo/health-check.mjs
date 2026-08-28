import process from "node:process";

const endpoints = [
  ["api", "http://127.0.0.1:47111/health"],
  ["web", "http://127.0.0.1:47112/health"],
];

const results = await Promise.all(
  endpoints.map(async ([name, url]) => {
    try {
      const response = await fetch(url);
      return { name, ready: response.ok };
    } catch {
      return { name, ready: false };
    }
  }),
);

for (const result of results) {
  process.stdout.write(`${result.ready ? "PASS" : "FAIL"} ${result.name}\n`);
}

if (results.some((result) => !result.ready)) {
  process.exitCode = 1;
}
