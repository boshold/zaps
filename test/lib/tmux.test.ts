import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process.spawn before importing tmux
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

import {
  listZapsSessions,
  hasSession,
  sendKeys,
  newSession,
  newWindow,
  killSession,
  splitPane,
  killPane,
  panePid,
  capturePane,
  sendCtrlC,
  setEnv,
  removeEnv,
  showEnv,
  selectPane,
  currentPaneId,
  currentSession,
  zoomPane,
  getWindowName,
  renameWindow,
  editPaneCapture,
  listPanes,
  displayPopup,
  getWindowOption,
  setWindowOption,
} from "../../src/lib/tmux.js";

const mockSpawn = vi.mocked(spawn);

function createMockProc(stdout: string, exitCode = 0, stderr = ""): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  proc.stdout = stdoutStream;
  proc.stderr = stderrStream;

  // Use setTimeout(0) so event handlers are attached first
  setTimeout(() => {
    stdoutStream.write(stdout);
    stdoutStream.end();
    stderrStream.write(stderr);
    stderrStream.end();
    proc.emit("close", exitCode);
  }, 0);

  return proc;
}

function createSilentMockProc(exitCode = 0): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess;
  setTimeout(() => proc.emit("close", exitCode), 0);
  return proc;
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe("listZapsSessions", () => {
  it("returns only sessions with ZAPS_PANE_MAP and live panes", async () => {
    mockSpawn
      // List-sessions
      .mockReturnValueOnce(createMockProc("foo\nbar\nbaz"))
      // Show-environment foo → has pane map
      .mockReturnValueOnce(createMockProc('ZAPS_PANE_MAP={"@tui":"%0","web":"%1"}'))
      // List-panes foo → panes alive
      .mockReturnValueOnce(createMockProc("%0:100:120:40\n%1:200:60:20"))
      // Show-environment bar → no pane map
      .mockReturnValueOnce(createMockProc("", 1, "unknown variable"))
      // Show-environment baz → has pane map
      .mockReturnValueOnce(createMockProc('ZAPS_PANE_MAP={"@tui":"%2"}'))
      // List-panes baz → pane alive
      .mockReturnValueOnce(createMockProc("%2:300:80:30"));
    const sessions = await listZapsSessions();
    expect(sessions).toEqual([
      { session: "foo", panes: 2 },
      { session: "baz", panes: 1 },
    ]);
  });

  it("excludes sessions where panes are dead", async () => {
    mockSpawn
      .mockReturnValueOnce(createMockProc("stale"))
      // Show-environment → has pane map
      .mockReturnValueOnce(createMockProc('ZAPS_PANE_MAP={"@tui":"%0","web":"%1"}'))
      // List-panes → none of the mapped panes exist
      .mockReturnValueOnce(createMockProc("%5:100:120:40"));
    const sessions = await listZapsSessions();
    expect(sessions).toEqual([]);
  });

  it("returns empty array on failure", async () => {
    mockSpawn.mockReturnValue(createMockProc("", 1, "no server running"));
    const sessions = await listZapsSessions();
    expect(sessions).toEqual([]);
  });

  it("handles empty output from list-sessions", async () => {
    mockSpawn.mockReturnValueOnce(createMockProc(""));
    const sessions = await listZapsSessions();
    expect(sessions).toEqual([]);
  });
});

describe("hasSession", () => {
  it("returns true when session exists", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    expect(await hasSession("my-sess")).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["has-session", "-t", "my-sess"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("returns false when session missing", async () => {
    mockSpawn.mockReturnValue(createMockProc("", 1, "session not found"));
    expect(await hasSession("nope")).toBe(false);
  });
});

describe("sendKeys", () => {
  it("sends literal keys then Enter", async () => {
    mockSpawn.mockReturnValueOnce(createMockProc("")).mockReturnValueOnce(createMockProc(""));
    await sendKeys("%1", "ls -la");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "tmux",
      ["send-keys", "-t", "%1", "-l", "ls -la"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(mockSpawn).toHaveBeenNthCalledWith(2, "tmux", ["send-keys", "-t", "%1", "Enter"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

describe("newSession", () => {
  it("creates detached session and returns pane ID", async () => {
    mockSpawn.mockReturnValue(createMockProc("%0"));
    const paneId = await newSession("my-project");
    expect(paneId).toBe("%0");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["new-session", "-d", "-s", "my-project", "-P", "-F", "#{pane_id}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("newWindow", () => {
  it("creates background window and returns pane ID", async () => {
    mockSpawn.mockReturnValue(createMockProc("%3"));
    const paneId = await newWindow("my-project");
    expect(paneId).toBe("%3");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["new-window", "-t", "my-project", "-d", "-P", "-F", "#{pane_id}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("killSession", () => {
  it("kills session by name", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    await killSession("my-project");
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["kill-session", "-t", "my-project"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

describe("splitPane", () => {
  it("splits horizontally without percent", async () => {
    mockSpawn.mockReturnValue(createMockProc("%2"));
    const paneId = await splitPane("%0", "h");
    expect(paneId).toBe("%2");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["split-window", "-h", "-t", "%0", "-P", "-F", "#{pane_id}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("splits vertically with percent", async () => {
    mockSpawn.mockReturnValue(createMockProc("%5"));
    const paneId = await splitPane("%1", "v", 30);
    expect(paneId).toBe("%5");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["split-window", "-v", "-t", "%1", "-l", "30%", "-P", "-F", "#{pane_id}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("killPane", () => {
  it("kills pane by target", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    await killPane("%2");
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["kill-pane", "-t", "%2"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

describe("panePid", () => {
  it("returns parsed PID", async () => {
    mockSpawn.mockReturnValue(createMockProc("12345"));
    const pid = await panePid("%0");
    expect(pid).toBe(12_345);
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["display-message", "-p", "-t", "%0", "#{pane_pid}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("capturePane", () => {
  it("captures default 100 lines", async () => {
    mockSpawn.mockReturnValue(createMockProc("line1\nline2\nline3"));
    const output = await capturePane("%0");
    expect(output).toBe("line1\nline2\nline3");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["capture-pane", "-t", "%0", "-p", "-S", "-100"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("captures custom number of lines", async () => {
    mockSpawn.mockReturnValue(createMockProc("output"));
    await capturePane("%1", 50);
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["capture-pane", "-t", "%1", "-p", "-S", "-50"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("sendCtrlC", () => {
  it("sends C-c without Enter", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    await sendCtrlC("%0");
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["send-keys", "-t", "%0", "C-c"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

describe("setEnv", () => {
  it("sets environment variable on session", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    await setEnv("my-project", "FOO", "bar");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["set-environment", "-t", "my-project", "FOO", "bar"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("removeEnv", () => {
  it("unsets environment variable on session", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    await removeEnv("my-project", "FOO");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["set-environment", "-u", "-t", "my-project", "FOO"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("showEnv", () => {
  it("strips key prefix and returns value", async () => {
    mockSpawn.mockReturnValue(createMockProc("MY_VAR=hello"));
    const value = await showEnv("sess", "MY_VAR");
    expect(value).toBe("hello");
  });

  it("returns null on error", async () => {
    mockSpawn.mockReturnValue(createMockProc("", 1, "unknown variable"));
    const value = await showEnv("sess", "MISSING");
    expect(value).toBeNull();
  });
});

describe("currentPaneId", () => {
  it("returns the pane id", async () => {
    mockSpawn.mockReturnValue(createMockProc("%5"));
    const id = await currentPaneId();
    expect(id).toBe("%5");
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["display-message", "-p", "#{pane_id}"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

describe("currentSession", () => {
  it("returns the session name", async () => {
    mockSpawn.mockReturnValue(createMockProc("my-session"));
    const name = await currentSession();
    expect(name).toBe("my-session");
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["display-message", "-p", "#{session_name}"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

describe("zoomPane", () => {
  it("calls selectPane then resize-pane -Z", async () => {
    mockSpawn.mockReturnValueOnce(createMockProc("")).mockReturnValueOnce(createMockProc(""));
    await zoomPane("%3");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn).toHaveBeenNthCalledWith(1, "tmux", ["select-pane", "-t", "%3"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(mockSpawn).toHaveBeenNthCalledWith(2, "tmux", ["resize-pane", "-Z", "-t", "%3"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

describe("getWindowName", () => {
  it("returns window name", async () => {
    mockSpawn.mockReturnValue(createMockProc("bash"));
    const name = await getWindowName("%0");
    expect(name).toBe("bash");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["display-message", "-p", "-t", "%0", "#{window_name}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("renameWindow", () => {
  it("renames window with correct args", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    await renameWindow("%0", "new-title");
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["rename-window", "-t", "%0", "new-title"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

describe("editPaneCapture", () => {
  it("calls displayPopup with capture command using vim by default", async () => {
    mockSpawn.mockReturnValue(createSilentMockProc(0));
    await editPaneCapture("%1", "Capture");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining([
        "display-popup",
        "-EE",
        "-w",
        "90%",
        "-h",
        "90%",
        "-T",
        "Capture",
        "--",
        expect.stringContaining("tmux capture-pane -t %1"),
      ]),
      { stdio: "ignore" },
    );
    // Should use vim or EDITOR
    const args = mockSpawn.mock.calls[0][1] as string[];
    const cmd = args[args.length - 1];
    expect(cmd).toMatch(/vim|nano|EDITOR/);
  });
});

describe("selectPane", () => {
  it("selects pane by target", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    await selectPane("%2");
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["select-pane", "-t", "%2"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

describe("listPanes", () => {
  it("parses pane info from output", async () => {
    mockSpawn.mockReturnValue(createMockProc("%0:1234:120:40\n%1:5678:60:20"));
    const panes = await listPanes("my-project");
    expect(panes).toEqual([
      { id: "%0", pid: 1234, width: 120, height: 40 },
      { id: "%1", pid: 5678, width: 60, height: 20 },
    ]);
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      [
        "list-panes",
        "-t",
        "my-project",
        "-F",
        "#{pane_id}:#{pane_pid}:#{pane_width}:#{pane_height}",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("returns empty array for empty output", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    const panes = await listPanes("empty-sess");
    expect(panes).toEqual([]);
  });
});

describe("displayPopup", () => {
  it("spawns tmux display-popup with correct args", async () => {
    mockSpawn.mockReturnValue(createSilentMockProc(0));
    await displayPopup({
      cwd: "/project",
      command: "npm test",
      title: "Test",
      width: "80%",
      height: "80%",
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      [
        "display-popup",
        "-EE",
        "-d",
        "/project",
        "-w",
        "80%",
        "-h",
        "80%",
        "-T",
        "Test",
        "--",
        "npm test",
      ],
      { stdio: "ignore" },
    );
  });

  it("passes env vars as -e flags", async () => {
    mockSpawn.mockReturnValue(createSilentMockProc(0));
    await displayPopup({
      cwd: "/project",
      command: "run",
      env: { FOO: "bar", BAZ: "qux" },
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["display-popup", "-EE", "-d", "/project", "-e", "FOO=bar", "-e", "BAZ=qux", "--", "run"],
      { stdio: "ignore" },
    );
  });

  it("rejects on non-zero exit code", async () => {
    mockSpawn.mockReturnValue(createSilentMockProc(1));
    await expect(displayPopup({ cwd: "/project", command: "fail" })).rejects.toThrow(
      "Popup command failed with code 1",
    );
  });
});

describe("getWindowOption", () => {
  it("returns the option value", async () => {
    mockSpawn.mockReturnValue(createMockProc("on"));
    const value = await getWindowOption("%0", "automatic-rename");
    expect(value).toBe("on");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["show-window-option", "-v", "-t", "%0", "automatic-rename"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("setWindowOption", () => {
  it("sets the option value", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    await setWindowOption("%0", "automatic-rename", "on");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["set-window-option", "-t", "%0", "automatic-rename", "on"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});
