import { z } from "zod";

import { discoverConfig } from "#src/config/discovery.js";
import { loadProjectContext } from "#src/config/project-context.js";
import { ensureDaemon } from "#src/daemon/index.js";
import { isDaemonRunning, socketPath } from "#src/daemon/lifecycle.js";
import { sessionId } from "#src/daemon/session.js";
import {
  ipcErrorResponseSchema,
  sessionCreateParamsSchema,
  sessionCreatedSchema,
} from "#src/lib/backend/schemas.js";
import type { BackendId } from "#src/lib/backend/types.js";
import { parseDaemonStatus, parseServiceStatus } from "#src/lib/backend/wire.js";
import { getEnv } from "#src/lib/env.js";
import { ipcRequest, ipcSend, ipcSubscribe } from "#src/lib/ipc/client.js";
import type { IpcSubscription } from "#src/lib/ipc/client.js";
import { captureEnvironment } from "#src/lib/request-context.js";
import { currentPaneId, currentSession, selectPane, sendKeys } from "#src/lib/tmux.js";

import { StartupArgumentError, selectStartupBackend } from "./backend-selection.js";
import type { StartupIntent } from "./backend-selection.js";
import { consumeManagedEnvironmentSnapshot, ensureTmuxContext } from "./bootstrap-tmux.js";
import type { ManagedStartup } from "./bootstrap-tmux.js";
import { renderCliError } from "./errors.js";
import {
  CliError,
  DAEMON_NOT_RUNNING,
  resolveCommand,
  resolveCommandArgv,
  resolveTargetSession,
} from "./helpers.js";
import { runTui } from "./run-tui.js";
import { findStartupSession, listStartupSessions, readDaemonResult } from "./startup-session.js";
import type { ListedSession } from "./startup-session.js";

const DETACH_INACTIVITY_MS = 120_000;

/** Report detached startup after the daemon's tracked run settles. */
async function reportDetachedStartup(
  sock: string,
  session: { id: string; name: string; backend?: BackendId },
): Promise<void> {
  const ctl: {
    sub?: IpcSubscription;
    inactivity?: ReturnType<typeof setTimeout>;
    done: boolean;
    anyError: boolean;
  } = { done: false, anyError: false };

  await new Promise<void>((resolve, reject) => {
    const finish = (action: () => void): void => {
      if (ctl.done) {
        return;
      }
      ctl.done = true;
      if (ctl.inactivity) {
        clearTimeout(ctl.inactivity);
      }
      ctl.sub?.close();
      action();
    };
    const arm = (): void => {
      if (ctl.done) {
        return;
      }
      if (ctl.inactivity) {
        clearTimeout(ctl.inactivity);
      }
      ctl.inactivity = setTimeout(() => {
        finish(() =>
          reject(
            new CliError(
              `No startup activity from the daemon for ${DETACH_INACTIVITY_MS / 1000}s; aborting.`,
            ),
          ),
        );
      }, DETACH_INACTIVITY_MS);
      ctl.inactivity.unref?.();
    };
    // The inactivity timer and socket-close handler bound both requests.
    const drive = async (): Promise<void> => {
      const { sub } = ctl;
      if (!sub) {
        throw new CliError("No startup subscription.");
      }
      await sub.subscribed;
      const params = session.backend === undefined ? undefined : { startup: true };
      const startRes = await sub.request("services.startAll", params, 0);
      z.strictObject({ started: z.literal("all") }).parse(readDaemonResult(startRes));
      if (session.backend === undefined) {
        const listRes = await sub.request("services.list", undefined, 0);
        const statuses = z
          .array(z.unknown())
          .parse(readDaemonResult(listRes))
          .map((status) => parseServiceStatus(status));
        ctl.anyError = statuses.some((s) => s.state === "error");
      }
      finish(() => resolve());
    };

    ctl.sub = ipcSubscribe(sock, session.id, ["service.stateChange", "log.lines"], {
      onEvent: () => {
        arm();
      },
      onClose: () => {
        finish(() => reject(new CliError("error: daemon connection closed")));
      },
      onError: (err) => {
        finish(() => reject(new CliError(`Error starting services: ${err}`)));
      },
    });
    arm();
    void drive().catch((error: unknown) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });

  if (ctl.anyError) {
    throw new CliError(`Session ${session.name}: one or more services failed to start.`);
  }
  const backend = session.backend ?? "tmux";
  process.stdout.write(
    `Session "${session.name}" started (${backend}). Run 'zaps attach' to open the UI.\n`,
  );
}

interface ProjectIdentity {
  configPath: string;
  projectDir: string;
  resolvedProjectDir: string;
}

const legacyTmuxCreatedSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  paneMap: z.record(z.string(), z.string()),
  focusPane: z.string().optional(),
});

function requireUiTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new StartupArgumentError(
      "invalid_request",
      "The UI requires interactive terminal input and output. Use an interactive terminal, or 'zaps -b' to start in the background.",
    );
  }
}

function renderStartupError(error: unknown, report?: (message: string) => void): never {
  const rendered =
    error instanceof StartupArgumentError ? `${error.code}: ${error.message}` : error;
  report?.(rendered instanceof Error ? rendered.message : String(rendered));
  return renderCliError(rendered);
}

async function startShell(project: ProjectIdentity, attachUi: boolean): Promise<void> {
  const sock = await ensureDaemon(resolveCommandArgv());
  const status = parseDaemonStatus(readDaemonResult(await ipcRequest(sock, "daemon.status")));
  if (!status.supportedBackends.includes("shell")) {
    throw new StartupArgumentError(
      "backend_unavailable",
      "The running daemon does not support the shell backend. Upgrade Zaps and restart the daemon when its running sessions can be stopped.",
    );
  }
  const params = sessionCreateParamsSchema.parse({ ...project, backend: "shell" });
  const session = sessionCreatedSchema.parse(
    readDaemonResult(await ipcRequest(sock, "session.create", params)),
  );
  if (
    session.backend !== "shell" ||
    session.id !== sessionId(project.configPath, project.resolvedProjectDir)
  ) {
    throw new CliError("Daemon returned an unexpected shell session.");
  }
  if (attachUi) {
    await runTui({ sessionId: session.id, socketPath: sock });
    return;
  }
  await reportDetachedStartup(sock, session);
}

async function startTmux(
  project: ProjectIdentity,
  attachUi: boolean,
  managed?: ManagedStartup,
): Promise<void> {
  const originPane = await currentPaneId();
  const tmuxSession = await currentSession(originPane);
  const sock = await ensureDaemon(resolveCommandArgv());
  if (managed) {
    managed.canRollback = false;
  }
  const response = await ipcRequest(sock, "session.create", {
    ...project,
    tmuxSession,
    originPane,
    tmuxSocket: getEnv("ZAPS_TMUX_SOCKET") ?? null,
    managedTmux: getEnv("ZAPS_MANAGED_TMUX") === "1",
  });
  const rejection = ipcErrorResponseSchema.safeParse(response);
  if (managed && rejection.success && rejection.data.errorCode === "backend_conflict") {
    managed.canRollback = true;
  }
  const raw = readDaemonResult(response);
  const session = z.union([sessionCreatedSchema, legacyTmuxCreatedSchema]).parse(raw);
  if ("backend" in session && session.backend !== "tmux") {
    throw new CliError("Daemon returned an unexpected tmux session.");
  }
  if (!attachUi) {
    await reportDetachedStartup(sock, session);
    return;
  }

  const tuiPaneId = session.paneMap["@tui"];
  const focusPane = session.focusPane ?? tuiPaneId;
  if (tuiPaneId === originPane) {
    await selectPane(focusPane);
    await runTui({
      sessionId: session.id,
      socketPath: sock,
      autoStart: true,
      onReady: managed?.onUiReady,
    });
  } else {
    await sendKeys(
      tuiPaneId,
      `${resolveCommand()} ui --session ${session.id} --socket ${sock} --start; exit`,
    );
    await selectPane(focusPane);
  }
}

const TASK_ONLY_HINT =
  "Session runs on the shell backend (created by 'zaps run'). For tmux panes: zaps down && zaps up\n";

function isTaskOnly(session: ListedSession): boolean {
  return session.backend === "shell" && session.startupPending === true;
}

/** Run the deferred initial startup of a session kept after `zaps run`. */
async function startPendingSession(
  sock: string,
  session: ListedSession,
  attachUi: boolean,
): Promise<void> {
  process.stderr.write(TASK_ONLY_HINT);
  if (!attachUi) {
    await reportDetachedStartup(sock, session);
    return;
  }
  await ipcSend(sock, "services.startAll", { startup: true }, session.id);
  await runTui({ sessionId: session.id, socketPath: sock });
}

function reportExisting(session: Pick<ListedSession, "name" | "backend">): void {
  process.stdout.write(
    `Session "${session.name}" is already running (${session.backend}). Run 'zaps attach' to open the UI.\n`,
  );
}

async function launchTmux(
  project: ProjectIdentity,
  attachUi: boolean,
  sock: string,
  existing: ListedSession | undefined,
  managed?: ManagedStartup,
): Promise<void> {
  const bootstrap = await ensureTmuxContext({
    configPath: project.configPath,
    projectDir: project.resolvedProjectDir,
    detach: !attachUi,
    knownSession: {
      current:
        existing?.backend === "tmux"
          ? {
              name: existing.name,
              tmuxSession: existing.tmuxSession ?? "",
              managed: existing.managed === true,
              tuiPane: existing.tuiPane ?? null,
            }
          : undefined,
    },
  });
  if (!bootstrap.proceed) {
    process.exitCode = bootstrap.exitCode;
    return;
  }
  if (!existing) {
    await startTmux(project, attachUi, managed);
    return;
  }
  if (attachUi) {
    await runTui({ sessionId: existing.id, socketPath: sock, onReady: managed?.onUiReady });
    return;
  }
  reportExisting(existing);
}

async function listRunningSessions(sock: string) {
  if (!isDaemonRunning()) {
    return undefined;
  }
  try {
    return await listStartupSessions(sock);
  } catch (error) {
    if (error instanceof CliError && error.message === DAEMON_NOT_RUNNING) {
      return undefined;
    }
    throw error;
  }
}

async function runStartup(
  intent: StartupIntent,
  sessionSelector: string | undefined,
  managed?: ManagedStartup,
): Promise<void> {
  if (!intent.background && !intent.detach) {
    requireUiTerminal();
  }
  if (managed && intent.explicitBackend === "tmux") {
    consumeManagedEnvironmentSnapshot();
  }

  const projectDir = process.cwd();
  const configPath = discoverConfig(projectDir);
  if (!configPath) {
    throw new CliError("No config found. Run `zaps init` to create one.");
  }
  const { config } = await loadProjectContext(configPath, projectDir, captureEnvironment());
  const sock = socketPath();
  const sessions = await listRunningSessions(sock);
  const existing = findStartupSession(sessions ?? [], configPath, config.projectDir);
  if (sessionSelector && sessions) {
    const target = resolveTargetSession(sessions, sessionSelector);
    if (existing && target.id !== existing.id) {
      throw new CliError(
        `Session "${target.name}" is from a different project. Use \`zaps attach -s ${sessionSelector}\` instead.`,
      );
    }
  }

  const { backend, attachUi } = selectStartupBackend(intent, existing?.backend);
  const project = { configPath, projectDir, resolvedProjectDir: config.projectDir };
  if (existing && isTaskOnly(existing)) {
    await startPendingSession(sock, existing, attachUi);
    return;
  }
  if (existing && !attachUi && (intent.background || backend === "shell")) {
    reportExisting(existing);
    return;
  }
  if (backend === "shell") {
    if (existing) {
      await runTui({ sessionId: existing.id, socketPath: sock });
      return;
    }
    await startShell(project, attachUi);
    return;
  }

  await launchTmux(project, attachUi, sock, existing, managed);
}

export { renderStartupError, reportDetachedStartup, requireUiTerminal, runStartup };
