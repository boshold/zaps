import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { shellEscape } from "#src/lib/service/env.js";

interface RawPaneLaunch {
  readonly file: string;
  readonly started: boolean;
  holder(): Promise<number>;
  confirm(): Promise<number>;
  start(): Promise<void>;
  release(): void;
  dispose(): void;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function createRawPaneLaunch(payload: string, active: () => void, shell = "sh"): RawPaneLaunch {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zaps-pane-launch-"));
  const launch = path.join(directory, "pid");
  const program = path.join(directory, "command.sh");
  const spawned = path.join(directory, "spawned");
  const confirmed = path.join(directory, "confirmed");
  const gate = path.join(directory, "go");
  const releaseGate = path.join(directory, "release");
  const descriptors = new Set<number>();
  let released = false;
  let payloadReleased = false;
  let attested = false;
  const close = (fd: number) => {
    if (descriptors.delete(fd)) {
      fs.closeSync(fd);
    }
  };
  const open = (file: string, flags: number) => {
    // eslint-disable-next-line no-bitwise, oxc/bad-bitwise-operator -- POSIX open flags
    const fd = fs.openSync(file, flags | fs.constants.O_NONBLOCK);
    descriptors.add(fd);
    return fd;
  };
  const { gateRead, gateWrite, releaseRead, releaseWrite } = (() => {
    try {
      execFileSync("mkfifo", ["-m", "600", gate, releaseGate]);
      const reader = open(gate, fs.constants.O_RDONLY);
      const writer = open(gate, fs.constants.O_WRONLY);
      const releaseReader = open(releaseGate, fs.constants.O_RDONLY);
      const releaseWriter = open(releaseGate, fs.constants.O_WRONLY);
      return {
        gateRead: reader,
        gateWrite: writer,
        releaseRead: releaseReader,
        releaseWrite: releaseWriter,
      };
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      for (const fd of descriptors) {
        close(fd);
      }
      throw error;
    }
  })();
  const check = () => {
    active();
    if (released) {
      throw new Error("Raw launch cancelled");
    }
  };
  async function pid(file: string): Promise<number> {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      check();
      try {
        const value = Number(fs.readFileSync(file, "utf8").trim());
        if (Number.isSafeInteger(value) && value > 0) {
          fs.chmodSync(file, 0o600);
          return value;
        }
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          throw error;
        }
      }
      // eslint-disable-next-line no-await-in-loop -- wait for a concrete launch acknowledgement
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Raw launch acknowledgement deadline exceeded");
  }
  const child = `printf '%s\\n' "$$" > ${shellEscape(spawned)}; exec ${shellEscape(shell)} -c ${shellEscape(payload)}`;
  try {
    fs.writeFileSync(
      program,
      `trap 'exit 0' INT TERM; exec 3< ${shellEscape(gate)}; printf '%s\\n' "$$" > ${shellEscape(launch)}; read -r ZAPS_PROBE <&3 || exit 127; printf '%s\\n' "$$" > ${shellEscape(confirmed)}; read -r ZAPS_LAUNCH <&3 || exit 127; exec 3<&-; exec 4< ${shellEscape(releaseGate)}; ${shellEscape(shell)} -c ${shellEscape(child)} 4<&-; read -r ZAPS_RELEASE <&4`,
      { mode: 0o600 },
    );
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    for (const fd of descriptors) {
      close(fd);
    }
    throw error;
  }
  return {
    file: program,
    get started() {
      return payloadReleased;
    },
    holder: async () => pid(launch),
    async confirm() {
      check();
      close(gateRead);
      fs.writeSync(gateWrite, "probe\n");
      const acknowledged = await pid(confirmed);
      attested = true;
      return acknowledged;
    },
    async start() {
      check();
      if (!attested) {
        throw new Error("Raw launch unconfirmed");
      }
      close(gateRead);
      fs.writeSync(gateWrite, "start\n");
      payloadReleased = true;
      close(gateWrite);
      await pid(spawned);
      close(releaseRead);
    },
    release() {
      released = true;
      fs.rmSync(gate, { force: true });
      fs.rmSync(releaseGate, { force: true });
      if (descriptors.has(releaseWrite)) {
        try {
          fs.writeSync(releaseWrite, "stop\n");
        } catch (error) {
          if (!hasCode(error, "EPIPE")) {
            throw error;
          }
        }
      }
      for (const fd of descriptors) {
        close(fd);
      }
    },
    dispose() {
      this.release();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

export { createRawPaneLaunch };
export type { RawPaneLaunch };
