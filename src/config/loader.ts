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

function validateSemantics(project: ProjectConfig): void {
  const serviceNames = Object.keys(project.services);

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

  // Validate task dependsOn refs
  if (project.tasks) {
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

  // Validate layout pane refs
  if (project.layout) {
    const paneNames = collectPaneNames(project.layout);

    for (const pane of paneNames) {
      if (pane !== "@tui" && !project.services[pane]) {
        throw new Error(`Layout references unknown pane '${pane}'`);
      }
    }

    for (const pane of paneNames) {
      if (pane !== "@tui" && project.services[pane]?.detached) {
        throw new Error(`Detached service '${pane}' must not appear in layout`);
      }
    }
  }
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

  const projectDir = path.dirname(configPath);
  const { lib, bindActions } = createZapsLib();
  const project: ProjectConfig = configFn(lib);
  const name = project.name || path.basename(projectDir);
  const resolved = { ...project, name };

  validateSemantics(resolved);

  return {
    project: resolved,
    configPath,
    projectDir,
    bindActions,
  };
}
