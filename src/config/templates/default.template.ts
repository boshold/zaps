const defaultTemplate = `import type { Library } from "{{ZAPS_PATH}}";

export function config({ defineProject }: Library) {
  return defineProject({
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
