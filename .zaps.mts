import type { Library } from ".";

export function config({ define }: Library) {
  return define({
    name: "zaps",
    services: {
      app: {
        start: "echo 'Replace with your start command'",
        ready: { port: 3000 },
      },
    },
  });
}
