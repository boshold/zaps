import { discoverConfig } from "#src/config/discovery.js";
import { loadProjectContext } from "#src/config/project-context.js";
import type { ResolvedConfig } from "#src/config/types.js";
import { sessionId } from "#src/daemon/session.js";
import { sessionCreateParamsSchema, sessionCreatedSchema } from "#src/lib/backend/schemas.js";
import type { SessionCreated } from "#src/lib/backend/schemas.js";
import { parseDaemonStatus } from "#src/lib/backend/wire.js";
import { ipcRequest } from "#src/lib/ipc/client.js";
import type { IpcResponse } from "#src/lib/ipc/protocol.js";
import { captureEnvironment } from "#src/lib/request-context.js";
import { CliError } from "#src/lib/session/resolve.js";

const NO_CONFIG = "No config found. Run `zaps init` to create one.";
const NO_IMPLICIT_SUPPORT =
  "The running daemon does not support running tasks without a session. Restart it when its sessions can be stopped.";

interface ShellProject {
  configPath: string;
  projectDir: string;
  resolvedProjectDir: string;
}

/** A rejected daemon request; keeps the IPC error code for callers that map it. */
class DaemonRejectionError extends CliError {
  public readonly code: string | undefined;

  public constructor(response: IpcResponse & { error: string }) {
    super(response.errorCode ? `${response.errorCode}: ${response.error}` : response.error);
    this.code = response.errorCode;
    this.name = "DaemonRejectionError";
  }
}

function readResult(response: IpcResponse): unknown {
  if (response.error !== undefined) {
    throw new DaemonRejectionError({ ...response, error: response.error });
  }
  return response.result;
}

async function createShellSession(
  sock: string,
  project: ShellProject,
  lifecycle: { startServices: false; ephemeral: true } | Record<string, never> = {},
): Promise<Extract<SessionCreated, { backend: "shell" }>> {
  const params = sessionCreateParamsSchema.parse({ ...project, ...lifecycle, backend: "shell" });
  const session = sessionCreatedSchema.parse(
    readResult(await ipcRequest(sock, "session.create", params)),
  );
  if (
    session.backend !== "shell" ||
    session.id !== sessionId(project.configPath, project.resolvedProjectDir)
  ) {
    throw new CliError("Daemon returned an unexpected shell session.");
  }
  return session;
}

function rawServiceName(error: DaemonRejectionError, config: ResolvedConfig): string {
  // Matches BackendCompatibilityError (src/lib/backend/compatibility.ts).
  const named = /Service '(?<name>[^']+)'/.exec(error.message)?.groups?.name;
  if (named) {
    return named;
  }
  const raw = Object.entries(config.project.services).find(([, service]) => service.raw === true);
  return raw?.[0] ?? "<service>";
}

/** Discover and load the project config for `cwd` without a daemon. */
async function loadLocalProject(
  cwd: string,
): Promise<{ configPath: string; config: ResolvedConfig }> {
  const configPath = discoverConfig(cwd);
  if (!configPath) {
    throw new CliError(NO_CONFIG);
  }
  const { config } = await loadProjectContext(configPath, cwd, captureEnvironment());
  return { configPath, config };
}

interface ImplicitSessionOptions {
  cwd: string;
  ensureDaemon: () => Promise<string>;
  /** Task key used in the raw-input hint. */
  task?: string;
}

/** Create (or join) the project's background shell session without starting services. */
async function ensureImplicitSession(
  options: ImplicitSessionOptions,
): Promise<{ sessionId: string; socketPath: string }> {
  const { configPath, config } = await loadLocalProject(options.cwd);
  const sock = await options.ensureDaemon();
  const status = parseDaemonStatus(readResult(await ipcRequest(sock, "daemon.status")));
  if (!status.implicitSessions) {
    throw new CliError(NO_IMPLICIT_SUPPORT);
  }
  try {
    const session = await createShellSession(
      sock,
      { configPath, projectDir: options.cwd, resolvedProjectDir: config.projectDir },
      { startServices: false, ephemeral: true },
    );
    return { sessionId: session.id, socketPath: sock };
  } catch (error) {
    if (error instanceof DaemonRejectionError && error.code === "unsupported_config") {
      const task = options.task ?? "<task>";
      throw new CliError(
        `Service "${rawServiceName(error, config)}" uses raw input, which needs tmux. Run "zaps up" first, then "zaps run ${task}".`,
      );
    }
    throw error;
  }
}

export {
  DaemonRejectionError,
  NO_CONFIG,
  createShellSession,
  ensureImplicitSession,
  loadLocalProject,
  readResult,
};
export type { ImplicitSessionOptions, ShellProject };
