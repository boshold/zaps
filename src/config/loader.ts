import path from "node:path";

import { detectCycles } from "#src/lib/service/graph.js";

import { createZapsLib } from "./builder.js";
import type { CombinedServiceMeta, LayoutNode, ProjectConfig, ResolvedConfig } from "./types.js";
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

/**
 * Expand docker services with `expand: true` into individual child services.
 * Each child shares a pane but has independent lifecycle and status.
 */
function expandDockerServices(project: ProjectConfig): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const toExpand: [string, (typeof project.services)[string]][] = [];

  for (const [name, svc] of Object.entries(project.services)) {
    if (svc.docker?.expand && Array.isArray(svc.docker.service)) {
      toExpand.push([name, svc]);
    }
  }

  for (const [groupName, svc] of toExpand) {
    // Create child services — destructure parent to inherit non-docker props
    const { docker: parentDocker, ...inherited } = svc;
    if (!parentDocker) {
      // eslint-disable-next-line no-continue -- guarded by filter above
      continue;
    }
    const { expand: _, service: svcNames, ...dockerFlags } = parentDocker;
    const childNames = Array.isArray(svcNames) ? svcNames : [svcNames];

    // Validate no naming collisions
    for (const childName of childNames) {
      if (childName === groupName) {
        // eslint-disable-next-line no-continue -- skip self-reference
        continue;
      }
      if (project.services[childName]) {
        throw new Error(
          `Docker expand collision: '${groupName}' expands '${childName}' which already exists as a service`,
        );
      }
    }

    // Remove parent service
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removing expanded parent
    delete project.services[groupName];

    for (let i = 0; i < childNames.length; i += 1) {
      const childName = childNames[i];
      const combined: CombinedServiceMeta = {
        group: groupName,
        allServices: [...childNames],
        isOwner: i === 0,
      };

      project.services[childName] = {
        ...inherited,
        docker: { ...dockerFlags, service: childName },
        _combined: combined,
      };
    }

    groups.set(groupName, [...childNames]);
  }

  // Rewrite dependsOn/restartWith: expand group name refs to all children
  for (const svc of Object.values(project.services)) {
    if (svc.dependsOn) {
      svc.dependsOn = svc.dependsOn.flatMap((dep) => groups.get(dep) ?? [dep]);
    }
    if (svc.restartWith) {
      svc.restartWith = svc.restartWith.flatMap((dep) => groups.get(dep) ?? [dep]);
    }
  }

  return groups;
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

function validateSemantics(project: ProjectConfig, groups: Map<string, string[]>): void {
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

  // Validate layout pane refs (accept group names as valid pane refs)
  if (project.layout) {
    const paneNames = collectPaneNames(project.layout);

    for (const pane of paneNames) {
      if (pane !== "@tui" && !project.services[pane] && !groups.has(pane)) {
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
  // Cache-bust: append unique query param to force re-import on reload
  const importUrl = `${absolutePath}?t=${Date.now()}`;
  const mod = await import(importUrl);

  const configFn = mod.config ?? mod.default;
  if (typeof configFn !== "function") {
    throw new Error("Config file must export a 'config' function or default export");
  }

  const configDir = path.dirname(configPath);
  const resolvedInvokeDir = invokeDir ?? process.cwd();
  const { lib, bindActions } = createZapsLib();
  const project: ProjectConfig = configFn(lib);

  const projectDir = resolveProjectDir(project.cwd, configDir, resolvedInvokeDir);

  // Expand docker services with expand: true before validation
  const groups = expandDockerServices(project);

  const name = project.name || path.basename(projectDir);
  const resolved = { ...project, name };

  validateSemantics(resolved, groups);

  return {
    project: resolved,
    configPath,
    projectDir,
    bindActions,
    groups,
  };
}
