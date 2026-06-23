import { spawn } from "node:child_process";
import path from "node:path";

import type { JitiOptions } from "jiti";
import { createJiti } from "jiti";

import { detectCycles } from "#src/lib/service/graph.js";
import { RESERVED_TASK_SHORTCUT_KEYS } from "#src/lib/taskShortcuts.js";
import { validateLayoutSizes } from "#src/lib/tmux-layout.js";

import { createZapsLib } from "./builder.js";
import { expandOverrideSchema } from "./schema.js";
import type {
  CombinedServiceMeta,
  LayoutNode,
  OptionalContext,
  ProjectConfig,
  ResolvedConfig,
  ServiceConfig,
  UnavailableServiceInfo,
} from "./types.js";
import { isLayoutLeaf, isLayoutSplit, isReadyOutput } from "./types.js";

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
 * Validate one expand child override against {@link expandOverrideSchema}, turning
 * forbidden keys (`start`/`run`/`docker`/`_combined`), unknown keys (typos), and
 * malformed values into a load-time error naming the group, child, and offending
 * key(s) (G7).
 */
function validateExpandOverride(
  groupName: string,
  childName: string,
  override: Record<string, unknown>,
): void {
  const result = expandOverrideSchema.safeParse(override);
  if (result.success) {
    return;
  }
  const keys = new Set<string>();
  for (const issue of result.error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        keys.add(key);
      }
    } else if (issue.path.length > 0) {
      keys.add(String(issue.path[0]));
    }
  }
  throw new Error(
    `Docker expand override for child '${childName}' in group '${groupName}' has invalid key(s): ` +
      `${[...keys].join(", ")}. The keys 'start', 'run', 'docker', and '_combined' cannot be ` +
      `overridden (they would silently replace the inherited command or discard the docker config); ` +
      `other keys must be valid service fields.`,
  );
}

function validateExpandNames(
  groupName: string,
  childNames: string[],
  overrides: Record<string, Record<string, unknown>>,
  services: Record<string, unknown>,
): void {
  for (const childName of childNames) {
    if (childName !== groupName && services[childName]) {
      throw new Error(
        `Docker expand collision: '${groupName}' expands '${childName}' which already exists as a service`,
      );
    }
  }
  for (const [key, override] of Object.entries(overrides)) {
    if (!childNames.includes(key)) {
      throw new Error(
        `Docker expand override '${key}' in '${groupName}' is not a valid service name. Valid: ${childNames.join(", ")}`,
      );
    }
    validateExpandOverride(groupName, key, override);
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
    // A string `service` is coerced to a one-element array below, so `expand` works
    // With either shape — no silent ignore when `service` is a bare string (G6).
    if (svc.docker?.expand) {
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

function warnNonAutostartDeps(project: ProjectConfig): void {
  for (const [name, svc] of Object.entries(project.services)) {
    if (svc.flags?.start === false) {
      continue;
    }
    for (const dep of svc.dependsOn ?? []) {
      if (project.services[dep]?.flags?.start === false) {
        process.stderr.write(
          `Warning: service '${name}' depends on non-autostart service '${dep}'; ` +
            `'${dep}' is treated as satisfied during 'zaps up' (start it explicitly with 'zaps start ${dep}').\n`,
        );
      }
    }
  }
}

/**
 * Reject detached services that ended up in a combined (pane-sharing) group —
 * e.g. `detached: true` set via a docker `expand` per-child override. Detached
 * Services run pane-less and so cannot share a group's tmux pane (E4). Runs
 * After expansion, where `_combined` membership is known.
 */
function validateDetachedGroups(project: ProjectConfig): void {
  for (const [name, svc] of Object.entries(project.services)) {
    if (svc.detached && svc._combined) {
      throw new Error(
        `Detached service '${name}' cannot be a member of combined group '${svc._combined.group}' — detached services run pane-less and cannot share a pane.`,
      );
    }
  }
}

/**
 * Reject `lazyPane: true` on a docker-group member (Q5 resolved: v1 load error;
 * Group-granularity lazy is a follow-up). Group members share a pane, so a
 * Per-member opt-out is ambiguous — does the whole group go lazy, or just the
 * Member's slice? Punt by erroring; the user can add `lazyPane` to the wrapping
 * Group once group-granularity lazy ships. Runs after expansion so the
 * `_combined` meta carries the owning group name.
 */
function validateLazyPaneGroups(project: ProjectConfig): void {
  for (const [name, svc] of Object.entries(project.services)) {
    if (svc.lazyPane === true && svc._combined) {
      throw new Error(
        `Service '${name}': 'lazyPane: true' is not supported on members of combined group '${svc._combined.group}' (group-granularity lazy panes are a follow-up). Remove 'lazyPane' from this member, or apply it at the group level once that is supported.`,
      );
    }
  }
}

// Explicit task shortcuts colliding with a reserved key (q/j/k) are dropped by getTaskShortcuts.
// Warn at load time so the user knows their requested key was ignored.
function warnReservedTaskShortcuts(project: ProjectConfig): void {
  for (const [key, task] of Object.entries(project.tasks ?? {})) {
    if (task.shortcut && RESERVED_TASK_SHORTCUT_KEYS.has(task.shortcut)) {
      process.stderr.write(
        `Warning: task '${key}' ('${task.name}') requests reserved shortcut '${task.shortcut}'; ` +
          `'${task.shortcut}' is reserved (q=quit, j/k=navigation) and the shortcut is dropped.\n`,
      );
    }
  }
}

function validateSemantics(project: ProjectConfig, groups: Map<string, string[]>): void {
  validateServiceDeps(project);
  warnNonAutostartDeps(project);
  warnReservedTaskShortcuts(project);
  validateDetachedGroups(project);
  validateLazyPaneGroups(project);

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
        throw new Error(
          `Detached service '${pane}' cannot appear in the layout — detached services run pane-less.`,
        );
      }
    }

    // Reject split sizes that would produce zero/negative tmux percents (E15).
    validateLayoutSizes(project.layout);
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
  // An empty/whitespace-only binary (e.g. an assignments-only command, or a
  // Caller passing "") is unavailable. Short-circuit WITHOUT spawning: on some
  // Shells `sh -c "command -v "` exits 0 (treating it as available), so the probe
  // Would be shell-dependent — this keeps it deterministic (G2).
  if (binary.trim() === "") {
    return false;
  }
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", `command -v ${binary}`]);
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Pick the binary to probe for an optional service. Skips leading `NAME=value`
 * environment-variable assignments so `STRIPE_KEY=x stripe listen` probes
 * `stripe`, not `STRIPE_KEY=x` (G2). A command that is only assignments (or
 * empty) yields `""`, which `checkBinaryAvailable` short-circuits to unavailable
 * without spawning, so the service is reported unavailable deterministically
 * rather than crashing or depending on shell behavior.
 */
function extractBinary(svc: ServiceConfig): string {
  const cmd = typeof svc.start === "string" ? svc.start : String(svc.run ?? "");
  const tokens = cmd.trim().split(/\s+/);
  return tokens.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) ?? "";
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
        let timer: ReturnType<typeof setTimeout> | undefined = undefined;
        try {
          available = await Promise.race([
            Promise.resolve(svc.optional(optionalCtx)),
            new Promise<boolean>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("timeout")), 5000);
            }),
          ]);
        } catch {
          available = false;
        } finally {
          clearTimeout(timer);
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
      // Promote the lone survivor but keep the collapsed split's own `size` so a
      // Stripped sibling doesn't distort the parent's proportions. If the split
      // Had no explicit size, keep the child's own size (G4).
      const [only] = children;
      return node.size === undefined ? only : { ...only, size: node.size };
    }
    return { ...node, children };
  }
  return node;
}

/**
 * Expand the strip set so that removing a combined group's owner removes the
 * whole group (G3). The owner runs `docker compose up` for every sibling (the
 * manager drives the group off `_combined.allServices`), so a non-owner child
 * cannot come up without it — the chosen, simpler-sound behavior is: owner
 * stripped → group degrades. Stripping a non-owner only removes that child.
 */
function cascadeOwnerStrip(project: ProjectConfig, strip: Set<string>): Set<string> {
  const result = new Set(strip);
  for (const [name, svc] of Object.entries(project.services)) {
    const combined = svc._combined;
    if (combined?.isOwner && result.has(name)) {
      for (const sibling of combined.allServices) {
        result.add(sibling);
      }
    }
  }
  return result;
}

/**
 * Update the `groups` map and surviving siblings' `_combined.allServices` after a
 * strip, and report which group panes should be removed from the layout (a group
 * shares ONE pane keyed by the group name, so it is only removed when ALL its
 * children are stripped; a partially-stripped group keeps its pane) (G3).
 */
function reconcileGroups(
  project: ProjectConfig,
  strip: Set<string>,
  groups: Map<string, string[]>,
): Set<string> {
  const removedGroupPanes = new Set<string>();
  for (const [groupName, children] of groups) {
    const survivors = children.filter((c) => !strip.has(c));
    if (survivors.length === 0) {
      groups.delete(groupName);
      removedGroupPanes.add(groupName);
    } else if (survivors.length !== children.length) {
      groups.set(groupName, survivors);
      for (const sibling of survivors) {
        const meta = project.services[sibling]?._combined;
        if (meta) {
          meta.allServices = [...survivors];
        }
      }
    }
  }
  return removedGroupPanes;
}

function stripUnavailableServices(
  project: ProjectConfig,
  unavailableNames: Set<string>,
  groups = new Map<string, string[]>(),
): void {
  const strip = cascadeOwnerStrip(project, unavailableNames);

  // Remove stripped services (originally-unavailable plus any cascaded group children).
  for (const name of strip) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removing unavailable service
    delete project.services[name];
  }

  const removedGroupPanes = reconcileGroups(project, strip, groups);

  // Clean dependsOn/restartWith in remaining services. This also drops the implicit
  // Owner-dependency of a non-owner child whose owner was stripped, and any
  // Reference to a stripped optional service (no hard load error — graceful) (G3).
  for (const svc of Object.values(project.services)) {
    if (svc.dependsOn) {
      svc.dependsOn = svc.dependsOn.filter((d) => !strip.has(d));
    }
    if (svc.restartWith) {
      svc.restartWith = svc.restartWith.filter((d) => !strip.has(d));
    }
  }

  // Collapse layout: strip individual service panes by name and any fully-stripped
  // Group's shared pane; a partially-stripped group keeps its pane.
  if (project.layout) {
    const removedPanes = new Set([...strip, ...removedGroupPanes]);
    const collapsed = collapseLayoutTree(project.layout, removedPanes);
    project.layout = collapsed ?? undefined;
  }
}

/**
 * In the Bun native binary, jiti's lazy babel require escapes the bundler, so
 * load the transform from the embedded asset. Other runtimes (dev tsx, node
 * bundle) resolve jiti's transform from node_modules and need nothing.
 */
async function nativeTransform(): Promise<JitiOptions["transform"]> {
  if (!process.versions.bun) {
    return undefined;
  }
  const { getNativeTransform } = await import("./native-babel.js");
  return getNativeTransform();
}

/**
 * Strip `g`/`y` flags from `ready.output` RegExps: those flags make `.test()`
 * stateful (`lastIndex` advances), causing flaky ready detection (C10). Rebuilds
 * the RegExp without them and warns, naming the service.
 */
function normalizeReadyOutputFlags(project: ProjectConfig): void {
  for (const [name, svc] of Object.entries(project.services)) {
    const { ready } = svc;
    if (!ready || !isReadyOutput(ready) || !(ready.output instanceof RegExp)) {
      continue;
    }
    const { flags } = ready.output;
    if (/[gy]/u.test(flags)) {
      ready.output = new RegExp(ready.output.source, flags.replace(/[gy]/gu, ""));
      process.stderr.write(
        `Warning: service '${name}' ready.output regex uses stateful 'g'/'y' flags; ` +
          `stripped them to keep ready detection deterministic.\n`,
      );
    }
  }
}

/**
 * Dynamically import and validate a zaps config file.
 */
export async function loadConfig(configPath: string, invokeDir?: string): Promise<ResolvedConfig> {
  const absolutePath = path.resolve(process.cwd(), configPath);
  const transform = await nativeTransform();
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: true,
    tryNative: false,
    interopDefault: true,
    ...(transform === undefined ? {} : { transform }),
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

  normalizeReadyOutputFlags(project);

  // Expand docker `expand` groups BEFORE resolving optionals so the availability
  // Checks run over the expanded child services: a per-child override `optional`
  // Is evaluated for that child, and a child depending on a stripped optional
  // Degrades gracefully instead of producing a hard load error (G3).
  const groups = expandDockerServices(project);

  const unavailableServices = await resolveOptionalServices(project.services);
  if (unavailableServices.size > 0) {
    stripUnavailableServices(project, new Set(unavailableServices.keys()), groups);
  }

  const projectDir = resolveProjectDir(project.cwd, configDir, resolvedInvokeDir);

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
