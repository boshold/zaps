const defaultTemplate = `import type { Library } from "{{ZAPS_PATH}}";

export function config({ define }: Library) {
  return define({
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
