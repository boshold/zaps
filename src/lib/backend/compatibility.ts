import type { ServiceConfig } from "#src/config/types.js";
import type { BackendCapabilities } from "#src/lib/backend/types.js";

class BackendCompatibilityError extends Error {
  public readonly code = "unsupported_config";

  public readonly service: string;

  public constructor(service: string) {
    super(`Service '${service}' sets raw: true, but this backend does not support raw input.`);
    this.service = service;
    this.name = "BackendCompatibilityError";
  }
}

function preflightBackendCompatibility(
  services: Readonly<Record<string, ServiceConfig>>,
  capabilities: BackendCapabilities,
): void {
  for (const [name, service] of Object.entries(services)) {
    if (service.raw === true && !capabilities.rawInput) {
      throw new BackendCompatibilityError(name);
    }
  }
}

export { BackendCompatibilityError, preflightBackendCompatibility };
