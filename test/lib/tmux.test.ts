import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process.spawn before importing tmux
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

import {
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
  getWindowSize,
  resizeWindow,
  resyncPaneSizes,
  swapPanes,
  selectLayout,
  windowLayout,
  paneIndexOrder,
  tmuxFor,
  detachClient,
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
  it("splits horizontally without options", async () => {
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
    const paneId = await splitPane("%1", "v", { percent: 30 });
    expect(paneId).toBe("%5");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["split-window", "-v", "-t", "%1", "-l", "30%", "-P", "-F", "#{pane_id}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("passes -d so the new pane does not steal focus", async () => {
    mockSpawn.mockReturnValue(createMockProc("%6"));
    await splitPane("%0", "h", { detached: true });
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["split-window", "-h", "-d", "-t", "%0", "-P", "-F", "#{pane_id}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("passes -b so the new pane is inserted before the target", async () => {
    mockSpawn.mockReturnValue(createMockProc("%7"));
    await splitPane("%0", "h", { before: true });
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["split-window", "-h", "-b", "-t", "%0", "-P", "-F", "#{pane_id}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("combines before + detached + percent in the documented order", async () => {
    mockSpawn.mockReturnValue(createMockProc("%8"));
    await splitPane("%0", "v", { before: true, detached: true, percent: 25 });
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["split-window", "-v", "-b", "-d", "-t", "%0", "-l", "25%", "-P", "-F", "#{pane_id}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("swapPanes", () => {
  it("issues swap-pane with -s and -t", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    await swapPanes("%2", "%4");
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["swap-pane", "-s", "%2", "-t", "%4"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

describe("selectLayout", () => {
  it("passes the layout string as a single argv element", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    const layout = "eb8f,100x30,0,0{50x30,0,0,1,49x30,51,0,2}";
    await selectLayout("@0", layout);
    // CRITICAL: layout is one element — the `{`/`[` never need shell escaping.
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["select-layout", "-t", "@0", layout], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Pin "layout is ONE argv element" — guards against accidental .join(" ").
    const [[, argv]] = mockSpawn.mock.calls;
    expect(Array.isArray(argv) && argv.at(-1)).toBe(layout);
  });
});

describe("windowLayout", () => {
  it("reads #{window_layout} via display-message", async () => {
    const layout = "a87d,100x30,0,0,0";
    mockSpawn.mockReturnValue(createMockProc(layout));
    expect(await windowLayout("@0")).toBe(layout);
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["display-message", "-p", "-t", "@0", "#{window_layout}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("paneIndexOrder", () => {
  it("parses pane index + id, sorted ascending by index", async () => {
    // Feed an out-of-order stream to assert the sort.
    mockSpawn.mockReturnValue(createMockProc("3 %7\n1 %5\n2 %6"));
    const order = await paneIndexOrder("@0");
    expect(order).toEqual([
      { index: 1, id: "%5" },
      { index: 2, id: "%6" },
      { index: 3, id: "%7" },
    ]);
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["list-panes", "-t", "@0", "-F", "#{pane_index} #{pane_id}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("returns an empty array when the window has no panes", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    expect(await paneIndexOrder("@0")).toEqual([]);
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
    mockSpawn.mockReturnValue(createMockProc("%0:1234:120:40:0\n%1:5678:60:20:1"));
    const panes = await listPanes("my-project");
    expect(panes).toEqual([
      { id: "%0", pid: 1234, width: 120, height: 40, dead: false },
      // `dead` is what the re-attach path reads to decide whether to respawn.
      { id: "%1", pid: 5678, width: 60, height: 20, dead: true },
    ]);
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      [
        "list-panes",
        "-t",
        "my-project",
        "-F",
        "#{pane_id}:#{pane_pid}:#{pane_width}:#{pane_height}:#{pane_dead}",
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

describe("getWindowSize", () => {
  it("parses window width and height", async () => {
    mockSpawn.mockReturnValue(createMockProc("255 63"));
    const size = await getWindowSize("%0");
    expect(size).toEqual({ width: 255, height: 63 });
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["display-message", "-p", "-t", "%0", "#{window_width} #{window_height}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("resizeWindow", () => {
  it("issues resize-window with explicit dimensions", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    await resizeWindow("%0", 200, 50);
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["resize-window", "-t", "%0", "-x", "200", "-y", "50"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
});

describe("resyncPaneSizes", () => {
  it("nudges the window smaller and back to force a pty re-push", async () => {
    // Sequence: read size -> read window-size opt -> manual -> shrink -> restore -> opt back.
    // Each call needs a fresh proc (a proc emits "close" only once).
    mockSpawn
      .mockImplementationOnce(() => createMockProc("152 18")) // GetWindowSize
      .mockImplementationOnce(() => createMockProc("latest")) // GetWindowOption(window-size)
      .mockImplementation(() => createMockProc("")); // All set/resize calls

    await resyncPaneSizes("%7", 0);

    const calls = mockSpawn.mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(calls).toEqual([
      "display-message -p -t %7 #{window_width} #{window_height}",
      "show-window-option -v -t %7 window-size",
      "set-window-option -t %7 window-size manual",
      "resize-window -t %7 -x 142 -y 16", // Width-10, height-2
      "resize-window -t %7 -x 152 -y 18", // Restored
      "set-window-option -t %7 window-size latest", // Prior option restored
    ]);
  });

  it("clamps the nudged size to sane minimums on tiny windows", async () => {
    mockSpawn
      .mockImplementationOnce(() => createMockProc("12 4"))
      .mockImplementationOnce(() => createMockProc("latest"))
      .mockImplementation(() => createMockProc(""));

    await resyncPaneSizes("%7", 0);

    const calls = mockSpawn.mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(calls).toContain("resize-window -t %7 -x 20 -y 5"); // Floored, not 2 / 2
  });

  it("swallows errors so startup is never blocked", async () => {
    mockSpawn.mockImplementation(() => createMockProc("", 1, "boom"));
    await expect(resyncPaneSizes("%7", 0)).resolves.toBeUndefined();
  });
});

describe("detachClient", () => {
  it("detaches the client owning the target pane", async () => {
    mockSpawn.mockReturnValue(createMockProc(""));
    await detachClient("%7");
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["detach-client", "-t", "%7"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});

describe("tmuxFor", () => {
  const originalSocket = process.env.ZAPS_TMUX_SOCKET;

  afterEach(() => {
    if (originalSocket === undefined) {
      delete process.env.ZAPS_TMUX_SOCKET;
    } else {
      process.env.ZAPS_TMUX_SOCKET = originalSocket;
    }
  });

  it("prefixes every command with -L <socket>", async () => {
    mockSpawn.mockReturnValue(createMockProc("%3"));
    const tmux = tmuxFor("foo");
    await tmux.splitPane("%0", "v");
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["-L", "foo", "split-window", "-v", "-t", "%0", "-P", "-F", "#{pane_id}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("targets the default server (no -L) for a null socket", async () => {
    process.env.ZAPS_TMUX_SOCKET = "ignored";
    mockSpawn.mockReturnValue(createMockProc("%0"));
    await tmuxFor(null).currentPaneId();
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["display-message", "-p", "#{pane_id}"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("ignores ZAPS_TMUX_SOCKET — the bound socket wins", async () => {
    process.env.ZAPS_TMUX_SOCKET = "env-socket";
    mockSpawn.mockReturnValue(createMockProc(""));
    await tmuxFor("bound").killPane("%1");
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["-L", "bound", "kill-pane", "-t", "%1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("binds the socket for display-popup too", async () => {
    mockSpawn.mockReturnValue(createSilentMockProc());
    await tmuxFor("zaps").displayPopup({ command: "echo hi" });
    expect(mockSpawn).toHaveBeenCalledWith(
      "tmux",
      ["-L", "zaps", "display-popup", "-EE", "--", "echo hi"],
      { stdio: "ignore" },
    );
  });

  it("module-level exports read ZAPS_TMUX_SOCKET per call", async () => {
    process.env.ZAPS_TMUX_SOCKET = "first";
    mockSpawn.mockImplementation(() => createMockProc(""));
    await killPane("%1");
    process.env.ZAPS_TMUX_SOCKET = "second";
    await killPane("%2");
    delete process.env.ZAPS_TMUX_SOCKET;
    await killPane("%3");

    const calls = mockSpawn.mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(calls).toEqual([
      "-L first kill-pane -t %1",
      "-L second kill-pane -t %2",
      "kill-pane -t %3",
    ]);
  });
});
