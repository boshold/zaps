import type { SentraConfig, SentraTarget } from "#src/config/types.js";

const DSN_PLACEHOLDER = "{dsn}";
const SEGMENT_MAX_LENGTH = 64;

/**
 * Env template for a service/task, or `null` when it is not opted in.
 * `enabled: false` disables every target; `{ env }` replaces the project
 * template and works without a project block.
 */
export function sentraTemplateFor(
  project: SentraConfig | undefined,
  target: SentraTarget | undefined,
): Record<string, string> | null {
  if (!target || project?.enabled === false) {
    return null;
  }
  if (target === true) {
    return project ? project.env : null;
  }
  return target.env;
}

export function resolveSentraEnv(
  template: Record<string, string>,
  dsn: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(template).map(([key, value]) => [key, value.replaceAll(DSN_PLACEHOLDER, dsn)]),
  );
}

/** Maps any string to a valid Sentra scope segment (`[A-Za-z0-9._-]{1,64}`, not `.`/`..`). */
export function sanitizeSegment(value: string): string {
  const segment = value
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/-{2,}/g, "-")
    .slice(0, SEGMENT_MAX_LENGTH);
  if (segment === "" || segment === "." || segment === "..") {
    return "default";
  }
  return segment;
}
