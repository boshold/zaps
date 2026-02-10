const defaultTemplate = `import type { ZapsLib } from "{{ZAPS_PATH}}";

export function config(z: ZapsLib) {
  return z.defineProject({
    name: "{{PROJECT_NAME}}",
    services: {
      app: {
        start: "echo 'Replace with your start command'",
        ready: { port: 3000 },
      },
    },
  });
}
`;

export default defaultTemplate;
