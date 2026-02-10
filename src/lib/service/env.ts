import type { EnvConfig, EnvDeps, ServiceContext, ServiceStatus } from "./types.js";

/**
 * Build a ServiceContext from current service statuses.
 */
export function buildServiceContext(
  statuses: Map<string, ServiceStatus>,
  projectDir: string,
): ServiceContext {
  const services: ServiceContext["services"] = {};
  for (const [name, status] of statuses) {
    services[name] = {
      port: status.ports[0],
      ports: status.ports,
      cwd: undefined, // eslint-disable-line no-undefined -- Required by interface
    };
  }
  return { services, projectDir };
}

/**
 * Resolve env config to a plain record.
 */
export function resolveEnv(
  envConfig: EnvConfig | undefined,
  ctx: ServiceContext,
): Record<string, string> {
  if (!envConfig) {
    return {};
  }
  if (typeof envConfig === "function") {
    return envConfig(ctx);
  }
  return envConfig;
}

/**
 * Escape a value for safe use in a shell single-quoted string.
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, String.raw`'\''`)}'`;
}

/**
 * Format an env record as an inline shell prefix (e.g., KEY='value' KEY2='val2').
 */
export function formatEnvForShell(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${shellEscape(v)}`)
    .join(" ");
}

/**
 * Set environment variables for a tmux session using set-environment.
 */
export async function setServiceEnv(
  session: string,
  env: Record<string, string>,
  deps: EnvDeps,
): Promise<void> {
  // Sequential calls required: tmux set-environment must complete before the next
  for (const [key, value] of Object.entries(env)) {
    await deps.setEnv(session, key, value);
  }
}
