import type { Library } from "@bosdev/zaps";

export function config({ define }: Library) {
  return define({
    name: "zaps-demo",
    services: {
      api: {
        start: "node server.mjs api 47111",
        ready: { http: { url: "http://127.0.0.1:47111/health", status: 200 } },
        url: "http://127.0.0.1:47111",
      },
      web: {
        start: "node server.mjs web 47112",
        ready: { http: { url: "http://127.0.0.1:47112/health", status: 200 } },
        dependsOn: ["api"],
        restartWith: ["api"],
        url: "http://127.0.0.1:47112",
      },
      docs: {
        start: "node server.mjs docs 47113",
        ready: { http: { url: "http://127.0.0.1:47113/health", status: 200 } },
        url: "http://127.0.0.1:47113",
      },
    },
    tasks: {
      health: {
        name: "Check services",
        description: "Verify the API and web endpoints",
        commands: "node health-check.mjs",
        shortcut: "h",
      },
      test: {
        name: "Run tests",
        commands: "node -e \"console.log('All demo tests passed')\"",
        shortcut: "e",
      },
    },
    layout: {
      direction: "columns",
      children: [
        { pane: "@tui", size: "65", focus: true },
        {
          direction: "rows",
          size: "35",
          children: [{ pane: "api" }, { pane: "web" }, { pane: "docs" }],
        },
      ],
    },
    ui: {
      icons: "unicode",
      notifications: "off",
      wideThreshold: 75,
    },
  });
}
