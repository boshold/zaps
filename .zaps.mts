import type { ZapsLib } from ".";

export function config(z: ZapsLib) {
  return z.defineProject({
    name: "zaps",
    services: {
      app: {
        start: "echo 'Replace with your start command'",
        ready: { port: 3000 },
      },
    },
  });
}
