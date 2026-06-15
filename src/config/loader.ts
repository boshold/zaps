import { spawn } from "node:child_process";
import path from "node:path";

import { createJiti } from "jiti";

import { detectCycles } from "#src/lib/service/graph.js";

import { createZapsLib } from "./builder.js";
import type {
  CombinedServiceMeta,
  LayoutNode,
  OptionalContext,
  ProjectConfig,
  ResolvedConfig,
  ServiceConfig,
  UnavailableServiceInfo,
} from "./types.js";
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

function validateExpandNames(
  groupName: string,
  childNames: string[],
  overrides: Record<string, unknown>,
  services: Record<string, unknown>,
): void {
  for (const childName of childNames) {
    if (childName !== groupName && services[childName]) {
      throw new Error(
        `Docker expand collision: '${groupName}' expands '${childName}' which already exists as a service`,
      );
    }
  }
  for (const key of Object.keys(overrides)) {
    if (!childNames.includes(key)) {
      throw new Error(
        `Docker expand override '${key}' in '${groupName}' is not a valid service name. Valid: ${childNames.join(", ")}`,
      );
    }
  }
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
    const { expand: expandVal, service: svcNames, ...dockerFlags } = parentDocker;
    const childNames = Array.isArray(svcNames) ? svcNames : [svcNames];
    const overrides = typeof expandVal === "object" ? expandVal : {};

    validateExpandNames(groupName, childNames, overrides, project.services);

    // Remove parent service
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removing expanded parent
    delete project.services[groupName];

    const [ownerName] = childNames;
    for (let i = 0; i < childNames.length; i += 1) {
      const childName = childNames[i];
      const combined: CombinedServiceMeta = {
        group: groupName,
        allServices: [...childNames],
        isOwner: i === 0,
      };

      // Non-owners implicitly depend on the owner (must wait for docker compose up)
      const childDeps = i === 0 ? inherited.dependsOn : [...(inherited.dependsOn ?? []), ownerName];

      // Merge per-child overrides (ready, hooks, env, etc.)
      const childOverride = overrides[childName] ?? {};

      project.services[childName] = {
        ...inherited,
        ...childOverride,
        dependsOn: childOverride.dependsOn
          ? [...(childDeps ?? []), ...childOverride.dependsOn]
          : childDeps,
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

async function checkBinaryAvailable(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", `command -v ${binary}`]);
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

function extractBinary(svc: ServiceConfig): string {
  const cmd = typeof svc.start === "string" ? svc.start : String(svc.run ?? "");
  const [binary] = cmd.trim().split(/\s+/);
  return binary;
}

async function resolveOptionalServices(
  services: Record<string, ServiceConfig>,
): Promise<Map<string, UnavailableServiceInfo>> {
  const optionalCtx: OptionalContext = { hasBinary: checkBinaryAvailable };
  const unavailable = new Map<string, UnavailableServiceInfo>();
  const checks = Object.entries(services)
    .filter(([, svc]) => svc.optional === true || typeof svc.optional === "function")
    .map(async ([name, svc]) => {
      let available = false;
      if (typeof svc.optional === "function") {
        try {
          available = await Promise.race([
            Promise.resolve(svc.optional(optionalCtx)),
            new Promise<boolean>((_resolve, reject) =>
              setTimeout(() => reject(new Error("timeout")), 5000),
            ),
          ]);
        } catch {
          available = false;
        }
      } else {
        available = await checkBinaryAvailable(extractBinary(svc));
      }
      if (!available) {
        const reason =
          typeof svc.optional === "function"
            ? "availability check returned false"
            : `binary '${extractBinary(svc)}' not found`;
        unavailable.set(name, { name, reason });
      }
    });
  await Promise.all(checks);
  return unavailable;
}

function collapseLayoutTree(node: LayoutNode, removedPanes: Set<string>): LayoutNode | null {
  if (isLayoutLeaf(node)) {
    return removedPanes.has(node.pane) ? null : node;
  }
  if (isLayoutSplit(node)) {
    const children = node.children
      .map((c) => collapseLayoutTree(c, removedPanes))
      .filter((c): c is LayoutNode => c !== null);
    if (children.length === 0) {
      return null;
    }
    if (children.length === 1) {
      return children[0];
    }
    return { ...node, children };
  }
  return node;
}

function stripUnavailableServices(project: ProjectConfig, unavailableNames: Set<string>): void {
  // Remove unavailable services
  for (const name of unavailableNames) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removing unavailable service
    delete project.services[name];
  }
  // Clean dependsOn and restartWith in remaining services
  for (const svc of Object.values(project.services)) {
    if (svc.dependsOn) {
      svc.dependsOn = svc.dependsOn.filter((d) => !unavailableNames.has(d));
    }
    if (svc.restartWith) {
      svc.restartWith = svc.restartWith.filter((d) => !unavailableNames.has(d));
    }
  }
  // Collapse layout tree
  if (project.layout) {
    const collapsed = collapseLayoutTree(project.layout, unavailableNames);
    project.layout = collapsed ?? undefined;
  }
}

/**
 * Dynamically import and validate a zaps config file.
 */
export async function loadConfig(configPath: string, invokeDir?: string): Promise<ResolvedConfig> {
  const absolutePath = path.resolve(process.cwd(), configPath);
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: true,
    tryNative: false,
    interopDefault: true,
  });
  const mod = await jiti.import<Record<string, unknown>>(absolutePath);

  const configFn = mod.config ?? mod.default;
  if (typeof configFn !== "function") {
    throw new Error("Config file must export a 'config' function or default export");
  }

  const configDir = path.dirname(configPath);
  const resolvedInvokeDir = invokeDir ?? process.cwd();
  const { lib, bindActions } = createZapsLib();
  const project: ProjectConfig = configFn(lib);

  // Resolve optional services and strip unavailable ones before expansion
  const unavailableServices = await resolveOptionalServices(project.services);
  if (unavailableServices.size > 0) {
    stripUnavailableServices(project, new Set(unavailableServices.keys()));
  }

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
    unavailableServices,
  };
}

/** @internal Exported for testing */
export { collapseLayoutTree, resolveOptionalServices, stripUnavailableServices };
