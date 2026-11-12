const defaultTemplate = `import type { Library } from "{{ZAPS_PATH}}";

export function config({ define }: Library) {
  return define({
    services: {
      app: {
        start: "echo 'Replace with your start command'",
        ready: { port: 3000 },
      },
    },
    // tasks: {
    //   // Independent task: runs right away, starts nothing.
    //   lint: { name: "Lint", commands: "pnpm lint" },
    //   // Needs "app" to be ready. autoStart starts it when it is not running.
    //   e2e: { name: "E2E tests", commands: "pnpm test:e2e", services: ["app"], autoStart: true },
    // },
  });
}
`;

export default defaultTemplate;
