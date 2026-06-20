/**
 * Resolve info + metadata the daemon retains for one run-in-pane run, keyed by
 * `runId`. The pane launches the hidden `exec-task` wrapper, which fetches the
 * `command`/`cwd`/`env` over IPC, runs it, and streams output back; `taskKey`/
 * `taskName` let the daemon complete the run when the wrapper reports its exit.
 */
export interface PaneRunInfo {
  command: string;
  cwd: string;
  env: Record<string, string>;
  taskKey: string;
  taskName: string;
}

export interface WrapperCommandOptions {
  zapsCommand: string;
  sessionId: string;
  runId: string;
}

/** Join resolved task commands into one POSIX `sh -c`-able command string. */
export function joinTaskCommands(resolvedCommands: string[]): string {
  return resolvedCommands.join(" && ");
}

/**
 * Build the line sent to the pane via `sendKeys`. It launches the hidden
 * `exec-task` wrapper, which resolves the task command from the daemon, runs it
 * (tee-ing stdout/stderr to the daemon's `TaskOutputStore`), and reports its exit
 * code — a single capture+completion path shared with background runs. The
 * invocation is a plain command (runId carries no shell metacharacters), so it
 * runs under any pane shell (bash/zsh/fish); the wrapper itself uses `sh -c` for
 * the task command, keeping the verified fish-safe execution.
 */
export function buildWrapperCommand(opts: WrapperCommandOptions): string {
  return `${opts.zapsCommand} -s ${opts.sessionId} exec-task ${opts.runId}`;
}
