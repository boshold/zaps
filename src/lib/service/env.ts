import { buildUrl } from "#src/config/helpers/context.js";

import type { EnvConfig, ServiceContext, ServiceStatus, UrlOptions } from "./types.js";

/**
 * Build a ServiceContext from current service statuses. Each service's `cwd`
 * resolves to its configured `cwd` (if any) or the project dir, so config
 * functions reading `ctx.services[x].cwd` get a real path (C9).
 */
export function buildServiceContext(
  statuses: Map<string, ServiceStatus>,
  projectDir: string,
  servicesConfig: Record<string, { cwd?: string }> = {},
): ServiceContext {
  const services: ServiceContext["services"] = {};
  for (const [name, status] of statuses) {
    services[name] = {
      port: status.ports[0],
      ports: status.ports,
      cwd: servicesConfig[name]?.cwd ?? projectDir,
    };
  }
  return {
    services,
    projectDir,
    url: (name: string, opts?: UrlOptions) => buildUrl(services, name, opts),
  };
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
  const record = typeof envConfig === "function" ? envConfig(ctx) : envConfig;
  // Drop null/undefined values (e.g. an unresolved `ctx.url()`) so the variable
  // Is omitted rather than spawned as an empty string.
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && value !== undefined) {
      resolved[key] = value;
    }
  }
  return resolved;
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
