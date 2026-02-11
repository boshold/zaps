import type { Library } from ".";

export function config({ defineProject }: Library) {
  return defineProject({
    name: "zaps",
    services: {
      app: {
        start: "echo 'Replace with your start command'",
        ready: { port: 3000 },
      },
    },
  });
}
