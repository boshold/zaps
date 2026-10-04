import { captureException, flush, init } from "@sentry/node";

init({ dsn: process.env.SENTRY_DSN, defaultIntegrations: false });

function failingHandler() {
  throw new Error("zaps-sentra-it");
}

try {
  failingHandler();
} catch (error) {
  captureException(error);
}
await flush(2000);

setInterval(() => {
  /* Keep running like a dev server */
}, 60_000);
