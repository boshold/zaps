import path from "node:path";

import { detectCycles } from "#src/lib/service/graph.js";
import type { LayoutNode, ProjectConfig, ResolvedConfig } from "./types.js";

import { createZapsLib } from "./builder.js";
import { isLayoutLeaf, isLayoutSplit } from "./types.js";

function collectPaneNames(node: LayoutNode): string[] {
  if (isLayoutLeaf(node)) {
    return [node.pane];
  }
  if (isLayoutSplit(node)) {
    return node.children.flatMap(collectPaneNames);
  }
  return [];
}

function validateServices(project: ProjectConfig): void {
  const serviceNames = Object.keys(project.services);

  // Each service must have start or run
  for (const name of serviceNames) {
    const svc = project.services[name];
    if (!svc.start && !svc.run) {
      throw new Error(`Service '${name}' must have 'start' or 'run' command`);
    }
  }

  // Validate service dependsOn refs
  for (const name of serviceNames) {
    const deps = project.services[name].dependsOn ?? [];
    for (const dep of deps) {
      if (!project.services[dep]) {
        throw new Error(`Service '${name}' references unknown dependency '${dep}'`);
      }
    }
  }

  // Detect circular deps in services
  const cycle = detectCycles(project.services);
  if (cycle) {
    throw new Error(`Circular dependency detected: ${cycle.join(" \u2192 ")}`);
  }
}

function validateTasks(project: ProjectConfig): void {
  if (!project.tasks) {
    return;
  }

  const taskNames = Object.keys(project.tasks);
  for (const name of taskNames) {
    const deps = project.tasks[name].dependsOn ?? [];
    for (const dep of deps) {
      if (!project.tasks[dep]) {
        throw new Error(`Task '${name}' references unknown dependency '${dep}'`);
      }
    }
  }
}

function validateLayout(project: ProjectConfig): void {
  if (!project.layout) {
    return;
  }

  const paneNames = collectPaneNames(project.layout);

  // Check for unknown panes
  for (const pane of paneNames) {
    if (pane !== "@tui" && !project.services[pane]) {
      throw new Error(`Layout references unknown pane '${pane}'`);
    }
  }

  // Detached services must not appear in layout
  for (const pane of paneNames) {
    if (pane !== "@tui" && project.services[pane]?.detached) {
      throw new Error(`Detached service '${pane}' must not appear in layout`);
    }
  }
}

function validate(project: ProjectConfig): void {
  // Name must be non-empty
  if (!project.name || typeof project.name !== "string") {
    throw new Error("Project name must be a non-empty string");
  }

  // Services must be non-empty
  if (
    !project.services ||
    typeof project.services !== "object" ||
    Object.keys(project.services).length === 0
  ) {
    throw new Error("Project must have at least one service");
  }

  validateServices(project);
  validateTasks(project);
  validateLayout(project);
}

/**
 * Dynamically import and validate a zaps config file.
 */
export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  const absolutePath = new URL(configPath, `file://${process.cwd()}/`).href;
  const mod = await import(absolutePath);

  const configFn = mod.config ?? mod.default;
  if (typeof configFn !== "function") {
    throw new Error("Config file must export a 'config' function or default export");
  }

  const project: ProjectConfig = configFn(createZapsLib());

  validate(project);

  return {
    project,
    configPath,
    projectDir: path.dirname(configPath),
  };
}
