import { describe, expect, it } from "vitest";

import {
  buildNextCommand,
  renderErrors,
  renderIssues,
  renderLiveLine,
  renderShow,
} from "#src/lib/sentra/render.js";
import type { ErrorRow, IssueRow } from "#src/lib/sentra/schemas.js";

const ERROR_ROW: ErrorRow = {
  id: "01928f3a-6c1e-7b2a-9f4d-2c8e1a7b5d10",
  receivedAt: "2026-10-03T14:02:11.204Z",
  service: "web",
  kind: "error",
  level: "error",
  title: "TypeError: Cannot read properties of undefined (reading 'name')",
  location: "components/User/Card.vue:42",
  issueId: "3810b118b3670022",
};

const ISSUE_ROW: IssueRow = {
  id: "3810b118b3670022",
  shortId: "PROJ-1",
  services: "api,web",
  level: "error",
  title: "FetchError: 500 /api/users",
  culprit: null,
  count: 3,
  firstSeen: "2026-10-03T14:00:00.000Z",
  lastSeen: "2026-10-03T14:02:13.880Z",
};

function localClock(iso: string): string {
  const date = new Date(iso);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

describe("renderErrors", () => {
  it("renders a TOON table", () => {
    expect(renderErrors({ errors: [ERROR_ROW], hasMore: false }, null)).toMatchInlineSnapshot(`
      "errors[1]{id,receivedAt,service,kind,level,title,location,issueId}:
        01928f3a-6c1e-7b2a-9f4d-2c8e1a7b5d10,"2026-10-03T14:02:11.204Z",web,error,error,"TypeError: Cannot read properties of undefined (reading 'name')","components/User/Card.vue:42",3810b118b3670022"
    `);
  });

  it("appends the next hint", () => {
    const next = "zaps sentra errors --skip 1";
    expect(renderErrors({ errors: [ERROR_ROW], hasMore: true }, next)).toMatch(
      /\nnext: zaps sentra errors --skip 1$/,
    );
  });

  it("renders empty lists", () => {
    expect(renderErrors({ errors: [], hasMore: false }, null)).toBe("errors[0]:");
  });

  it("quotes titles with commas and quotes, and null values", () => {
    const row = { ...ERROR_ROW, title: 'Error: a, "b"', level: null, issueId: null, location: "" };
    expect(renderErrors({ errors: [row], hasMore: false }, null)).toMatchInlineSnapshot(`
      "errors[1]{id,receivedAt,service,kind,level,title,location,issueId}:
        01928f3a-6c1e-7b2a-9f4d-2c8e1a7b5d10,"2026-10-03T14:02:11.204Z",web,error,null,"Error: a, \\"b\\"","",null"
    `);
  });
});

describe("renderIssues", () => {
  it("renders a TOON table with next hint", () => {
    expect(renderIssues({ issues: [ISSUE_ROW], hasMore: true }, "zaps sentra issues --skip 20"))
      .toMatchInlineSnapshot(`
        "issues[1]{id,shortId,services,level,title,culprit,count,firstSeen,lastSeen}:
          3810b118b3670022,PROJ-1,"api,web",error,"FetchError: 500 /api/users",null,3,"2026-10-03T14:00:00.000Z","2026-10-03T14:02:13.880Z"
        next: zaps sentra issues --skip 20"
      `);
  });

  it("renders empty lists", () => {
    expect(renderIssues({ issues: [], hasMore: false }, null)).toBe("issues[0]:");
  });
});

describe("renderShow", () => {
  it("returns the markdown", () => {
    const issue = {
      ...ISSUE_ROW,
      project: "proj",
      session: "aaaaaaaaaaaa",
      fingerprint: [],
      fingerprintHash: "h",
      kind: "error" as const,
      platform: null,
      firstSeenAt: ISSUE_ROW.firstSeen,
      lastSeenAt: ISSUE_ROW.lastSeen,
      lastItemId: "i",
      services: ["web"],
      latest: null,
    };
    expect(renderShow({ type: "issue", issue, markdown: "# Title" })).toBe("# Title");
    expect(renderShow({ type: "issue", issue, markdown: "# T\u001B]0;x\u0007\n\tok" })).toBe(
      "# T]0;x\n\tok",
    );
  });
});

describe("renderLiveLine", () => {
  it("adds an indented location line", () => {
    expect(renderLiveLine(ERROR_ROW)).toBe(
      `${localClock(ERROR_ROW.receivedAt)} web error TypeError: Cannot read properties of undefined (reading 'name')\n         at components/User/Card.vue:42`,
    );
  });

  it("prints one line without location and falls back to kind", () => {
    const row = { ...ERROR_ROW, level: null, kind: "log" as const, location: "", title: "a\nb" };
    expect(renderLiveLine(row)).toBe(`${localClock(row.receivedAt)} web log a b`);
  });

  it("drops terminal control sequences from event fields", () => {
    const row = {
      ...ERROR_ROW,
      title: "boom\u001B]52;c;YXR0YWNrZXI=\u0007 \u009B31m",
      location: "a.ts:1\u001B[2J",
    };
    expect(renderLiveLine(row)).toBe(
      `${localClock(row.receivedAt)} web error boom]52;c;YXR0YWNrZXI= 31m\n         at a.ts:1[2J`,
    );
  });

  it("tolerates invalid timestamps", () => {
    expect(renderLiveLine({ ...ERROR_ROW, receivedAt: "nope", location: "" })).toMatch(
      /^--:--:-- web/,
    );
  });
});

describe("buildNextCommand", () => {
  it("adds --skip", () => {
    expect(buildNextCommand(["sentra", "errors", "--from", "2026-10-03T14:00:00Z"], 0, 2)).toBe(
      "zaps sentra errors --from 2026-10-03T14:00:00Z --skip 2",
    );
  });

  it("replaces existing --skip in both forms", () => {
    expect(buildNextCommand(["sentra", "errors", "--skip", "4", "--limit", "2"], 4, 2)).toBe(
      "zaps sentra errors --limit 2 --skip 6",
    );
    expect(buildNextCommand(["sentra", "issues", "--skip=4"], 4, 20)).toBe(
      "zaps sentra issues --skip 24",
    );
  });

  it("shell-quotes unsafe args", () => {
    expect(buildNextCommand(["sentra", "errors", "--q", "can't read"], 0, 20)).toBe(
      String.raw`zaps sentra errors --q 'can'\''t read' --skip 20`,
    );
  });
});
