import { ConfigError } from "#src/config/errors.js";
import type { ServiceContext, UrlOptions } from "#src/config/types.js";

/**
 * Pure URL builder backing `ctx.url()`. Throws on an unknown service, returns
 * `null` when no port is available (neither an override nor a detected port),
 * else assembles a total URL: `{protocol}://{auth@}{host}:{port}{path}` with
 * `http`/`localhost` defaults, IPv6 hosts bracketed, and a leading slash added
 * to a non-empty path that lacks one (Q-R4c).
 */
export function buildUrl(
  services: ServiceContext["services"],
  name: string,
  opts: UrlOptions = {},
): string | null {
  const service = services[name];
  if (!service) {
    throw new ConfigError(`ctx.url(): unknown service '${name}'`, {
      kind: "validation",
      service: name,
    });
  }

  const port = opts.port ?? service.port;
  if (port === undefined) {
    return null;
  }

  const protocol = opts.protocol ?? "http";
  const host = opts.host ?? "localhost";
  const bracketedHost = host.includes(":") ? `[${host}]` : host;
  const auth = opts.auth !== undefined && opts.auth !== "" ? `${opts.auth}@` : "";

  let path = "";
  if (opts.path !== undefined && opts.path !== "") {
    path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  }

  return `${protocol}://${auth}${bracketedHost}:${port}${path}`;
}
