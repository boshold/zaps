import type { ResolvedConfig } from "#src/config/types.js";

export function resolveExecutionUnits(config: ResolvedConfig): Map<string, string> {
  const units = new Map<string, string>();
  for (const [name, service] of Object.entries(config.project.services)) {
    const members = service._combined?.allServices ?? [name];
    const owner = members.find((member) => config.project.services[member]?._combined?.isOwner);
    units.set(name, owner ?? name);
  }
  return units;
}
