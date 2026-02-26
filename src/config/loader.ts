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

function validateServiceDeps(project: ProjectConfig): void {
  for (const [name, svc] of Object.entries(project.services)) {
    const deps = svc.dependsOn ?? [];
    for (const dep of deps) {
      if (!project.services[dep]) {
        throw new Error(`Service '${name}' references unknown dependency '${dep}'`);
      }
    }
    for (const dep of svc.restartWith ?? []) {
      if (!deps.includes(dep)) {
        throw new Error(`Service '${name}' restartWith '${dep}' is not in dependsOn`);
      }
    }
  }

  const cycle = detectCycles(project.services);
  if (cycle) {
    throw new Error(`Circular dependency detected: ${cycle.join(" \u2192 ")}`);
  }
}

function validateSemantics(project: ProjectConfig): void {
  validateServiceDeps(project);

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

function resolveProjectDir(
  cwd: ProjectConfig["cwd"],
  configDir: string,
  invokeDir: string,
): string {
  if (typeof cwd === "string") {
    return path.isAbsolute(cwd) ? cwd : path.resolve(configDir, cwd);
  }
  if (typeof cwd === "function") {
    const result = cwd({ configDir, invokeDir });
    return path.isAbsolute(result) ? result : path.resolve(configDir, result);
  }
  return invokeDir;
}

/**
 * Dynamically import and validate a zaps config file.
 */
export async function loadConfig(configPath: string, invokeDir?: string): Promise<ResolvedConfig> {
  const absolutePath = new URL(configPath, `file://${process.cwd()}/`).href;
  const mod = await import(absolutePath);

  const configFn = mod.config ?? mod.default;
  if (typeof configFn !== "function") {
    throw new Error("Config file must export a 'config' function or default export");
  }

  const configDir = path.dirname(configPath);
  const resolvedInvokeDir = invokeDir ?? process.cwd();
  const { lib, bindActions } = createZapsLib();
  const project: ProjectConfig = configFn(lib);

  const projectDir = resolveProjectDir(project.cwd, configDir, resolvedInvokeDir);

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
