import { shellEscape } from "#src/lib/service/env.js";
import { signalChannel, waitForChannel } from "#src/lib/tmux.js";

/**
 * Per-run tmux `wait-for` channels. The pane command signals exactly one of them
 * on exit (`ok` on success, `err` on failure); the daemon blocks on both and the
 * winner reports the outcome. Namespaced by `runId` so concurrent runs never
 * cross-signal (Q12).
 */
export function paneChannels(runId: string): { ok: string; err: string } {
  return { ok: `zaps_done_ok_${runId}`, err: `zaps_done_err_${runId}` };
}

export interface PaneCommandOptions {
  cwd: string;
  env: Record<string, string>;
  runId: string;
}

/**
 * Build the POSIX `sh` script that runs the task in the pane. It `cd`s into the
 * task cwd, runs the resolved commands in a subshell (so exported env never leaks
 * into the surrounding shell), then signals the run's completion channel with the
 * captured exit status — so completion is detected by the daemon waiting on that
 * channel, not by scraping the pane.
 */
export function buildPaneScript(resolvedCommands: string[], opts: PaneCommandOptions): string {
  const { ok, err } = paneChannels(opts.runId);
  const exportsPart = Object.entries(opts.env)
    .map(([k, v]) => `export ${k}=${shellEscape(v)};`)
    .join(" ");
  const body = resolvedCommands.join(" && ");
  const inner = exportsPart ? `${exportsPart} ${body}` : body;
  return (
    `cd ${shellEscape(opts.cwd)} && ( ${inner} ); __zrc=$?; ` +
    `if [ "$__zrc" -eq 0 ]; then tmux wait-for -S ${ok}; else tmux wait-for -S ${err}; fi`
  );
}

/**
 * Build the single line sent to the pane via `sendKeys`. The script is run under
 * an explicit `sh -c` so its POSIX syntax (exit-code branching, `wait-for`) works
 * regardless of the user's interactive pane shell (bash/zsh/fish). The pane's
 * `$TMUX` is inherited by `sh`, so `tmux wait-for` targets the same server.
 */
export function buildPaneCommand(resolvedCommands: string[], opts: PaneCommandOptions): string {
  return `sh -c ${shellEscape(buildPaneScript(resolvedCommands, opts))}`;
}

/**
 * Block (daemon-side) until the pane command signals completion, returning its
 * outcome. Both channels are awaited; once the winner resolves, the losing waiter
 * is released so its tmux client exits instead of lingering.
 */
export async function awaitPaneOutcome(runId: string): Promise<"success" | "error"> {
  const { ok, err } = paneChannels(runId);
  const result = await Promise.race([
    (async (): Promise<"success"> => {
      await waitForChannel(ok);
      return "success";
    })(),
    (async (): Promise<"error"> => {
      await waitForChannel(err);
      return "error";
    })(),
  ]);
  await signalChannel(result === "success" ? err : ok).catch(() => {
    /* Best-effort release of the losing waiter */
  });
  return result;
}
