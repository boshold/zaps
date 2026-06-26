export { discoverConfig } from "./discovery.js";
export { ConfigError } from "./errors.js";
export type { ConfigErrorKind } from "./errors.js";
export { loadConfig } from "./loader.js";
export { createZapsLib } from "./builder.js";
export { generateTemplate, scaffoldConfig } from "./scaffold.js";
export { projectConfigSchema, resolveUiConfig, uiConfigSchema } from "./schema.js";
export type { ResolvedUiConfig } from "./schema.js";
export type * from "./types.js";
