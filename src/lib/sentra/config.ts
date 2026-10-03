import type { SentraConfig, SentraTarget } from "#src/config/types.js";

const DSN_PLACEHOLDER = "{dsn}";
const SEGMENT_MAX_LENGTH = 64;

interface SentraTargets {
  sentra?: SentraConfig;
  services: Record<string, { sentra?: SentraTarget }>;
  tasks?: Record<string, { sentra?: SentraTarget }>;
}

/** Subset of `SentraHost` the injection points need. */
export interface SentraHostLike {
  ensureStarted(): Promise<object | null>;
  getDsn(scope: { project: string; session: string; service: string }): string;
  addSourceRoot(dir: string): void;
  status(): { reason: string | null };
}

/** Per-session Sentra wiring passed to services and tasks. */
export interface SentraDeps {
  host: SentraHostLike;
  /** Sanitized session name. */
  project: string;
  /** Session id. */
  session: string;
  projectDir: string;
  /** Daemon log; defaults to stderr (which the daemon redirects to its log). */
  log?: (msg: string) => void;
  /** Called on every service start that got Sentra env; `service` is the scope segment. */
  onServiceStart?: (service: string, startedAt: number) => void;
}

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

/** Sentra is on with a project block, or when any service/task brings its own `{ env }`. */
export function sentraEnabledFor(project: SentraTargets): boolean {
  if (project.sentra?.enabled === false) {
    return false;
  }
  if (project.sentra !== undefined) {
    return true;
  }
  const targets = [...Object.values(project.services), ...Object.values(project.tasks ?? {})];
  return targets.some((target) => sentraTemplateFor(project.sentra, target.sentra) !== null);
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

export function sentraLog(deps: SentraDeps, msg: string): void {
  if (deps.log) {
    deps.log(msg);
    return;
  }
  process.stderr.write(`${msg}\n`);
}

/**
 * Starts the host if needed and resolves `template` for one service/task.
 * `null` when the host is unavailable (logged; callers run without Sentra env).
 */
export async function buildSentraEnv(
  deps: SentraDeps,
  template: Record<string, string>,
  name: string,
): Promise<Record<string, string> | null> {
  if ((await deps.host.ensureStarted()) === null) {
    sentraLog(
      deps,
      `sentra: ${name} starts without Sentra env (${deps.host.status().reason ?? "unavailable"})`,
    );
    return null;
  }
  deps.host.addSourceRoot(deps.projectDir);
  const dsn = deps.host.getDsn({
    project: deps.project,
    session: deps.session,
    service: sanitizeSegment(name),
  });
  return resolveSentraEnv(template, dsn);
}

/** Sentra env for a service/task target; `{}` when not opted in or unavailable. */
export async function sentraEnvFor(
  deps: SentraDeps | undefined,
  project: SentraConfig | undefined,
  target: SentraTarget | undefined,
  name: string,
): Promise<Record<string, string>> {
  const template = sentraTemplateFor(project, target);
  if (!deps || !template) {
    return {};
  }
  return (await buildSentraEnv(deps, template, name)) ?? {};
}
