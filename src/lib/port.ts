import { createProcessInspection } from "./backend/runtime/process-inspection.js";
import type { TmuxHandle } from "./tmux.js";

type PortTmux = Pick<TmuxHandle, "panePid">;

// Preserve the legacy best-effort bridge until readiness uses neutral probes.
async function legacyProbe(probe: () => Promise<number[]>): Promise<number[]> {
  try {
    return await probe();
  } catch {
    return [];
  }
}

async function getDescendantPids(rootPid: number): Promise<number[]> {
  return legacyProbe(async () => createProcessInspection().getDescendantPids(rootPid));
}

async function getListeningPorts(pids: number[]): Promise<number[]> {
  return legacyProbe(async () => createProcessInspection().getListeningPorts(pids));
}

async function detectPortsForPid(rootPid: number): Promise<number[]> {
  return legacyProbe(async () => createProcessInspection().detectPortsForPid(rootPid));
}

async function detectPorts(paneTarget: string, tmux: PortTmux): Promise<number[]> {
  return detectPortsForPid(await tmux.panePid(paneTarget));
}

export { getDescendantPids, getListeningPorts, detectPorts, detectPortsForPid };
