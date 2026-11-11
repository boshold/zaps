import fs from "node:fs";
import path from "node:path";

import {
  SyntaxKind,
  isBinaryExpression,
  isCallExpression,
  isCaseClause,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isRegularExpressionLiteral,
  isStringLiteral,
  isVariableDeclaration,
} from "typescript/unstable/ast";
import type { CallExpression, Node, SourceFile } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";

const adapterFiles = new Set([
  "src/lib/tmux.ts",
  "src/lib/tmux-default.ts",
  "src/lib/tmux-layout.ts",
  "src/lib/tmux-reflow.ts",
  "src/lib/managed-tmux.ts",
  "src/lib/port.ts",
  "src/lib/task/popup-picker.ts",
  "src/lib/task/output-popup.ts",
  "src/lib/backend/tmux/driver.ts",
  "src/lib/backend/tmux/operations.ts",
  "src/lib/backend/tmux/output.ts",
  "src/lib/backend/tmux/pane-cleanup.ts",
  "src/lib/backend/tmux/raw-launch.ts",
  "src/lib/backend/tmux/runtime.ts",
  "src/lib/backend/tmux/session.ts",
  "src/lib/backend/tmux/terminal.ts",
  "src/lib/backend/tmux/wrapper-schema.ts",
  "src/daemon/log-monitor.ts",
]);
const compositionImports = new Map<string, ReadonlySet<string>>([
  ["src/lib/backend/factory.ts", new Set(["src/lib/backend/tmux/session.ts"])],
  ["src/cli.tsx", new Set(["src/lib/tmux.ts", "src/lib/managed-tmux.ts"])],
  ["src/cli/startup.ts", new Set(["src/lib/tmux.ts", "src/lib/managed-tmux.ts"])],
  [
    "src/cli/bootstrap-tmux.ts",
    new Set(["src/lib/tmux.ts", "src/lib/managed-tmux.ts", "src/lib/tmux-default.ts"]),
  ],
  ["src/cli/tmux-context.ts", new Set(["src/lib/tmux.ts", "src/lib/managed-tmux.ts"])],
  ["src/cli/run-tui.tsx", new Set(["src/lib/tmux.ts"])],
  ["src/cli/exec-service.ts", new Set(["src/lib/backend/tmux/wrapper-schema.ts"])],
  [
    "src/cli/exec-task.ts",
    new Set(["src/lib/backend/tmux/raw-launch.ts", "src/lib/backend/tmux/wrapper-schema.ts"]),
  ],
  [
    "src/daemon/server.ts",
    new Set([
      "src/lib/backend/tmux/session.ts",
      "src/lib/backend/tmux/driver.ts",
      "src/lib/backend/tmux/operations.ts",
      "src/lib/backend/tmux/runtime.ts",
      "src/lib/backend/tmux/terminal.ts",
      "src/lib/managed-tmux.ts",
      "src/lib/tmux.ts",
      "src/lib/port.ts",
    ]),
  ],
  [
    "src/daemon/handlers/session.ts",
    new Set(["src/lib/backend/tmux/runtime.ts", "src/lib/backend/tmux/wrapper-schema.ts"]),
  ],
]);

function modulePath(file: string, specifier: string): string | undefined {
  let resolved: string | undefined;
  if (specifier.startsWith("#src/")) {
    resolved = `src/${specifier.slice(5)}`;
  } else if (specifier.startsWith(".")) {
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  }
  return resolved?.replace(/\.js$/u, ".ts");
}

function boundaryViolations(file: string, source: SourceFile): string[] {
  const violations: string[] = [];
  const subprocessNames = new Set([
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "execFileAsync",
  ]);
  function bindings(node: Node): void {
    if (
      isImportDeclaration(node) &&
      isStringLiteral(node.moduleSpecifier) &&
      ["node:child_process", "child_process"].includes(node.moduleSpecifier.text)
    ) {
      const named = node.importClause?.namedBindings;
      if (named && isNamedImports(named)) {
        for (const binding of named.elements) {
          subprocessNames.add(binding.name.text);
        }
      }
    }
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer) {
      const value = node.initializer;
      if (
        (isIdentifier(value) && subprocessNames.has(value.text)) ||
        (isCallExpression(value) &&
          value.arguments.some(
            (argument) => isIdentifier(argument) && subprocessNames.has(argument.text),
          ))
      ) {
        subprocessNames.add(node.name.text);
      }
    }
    node.forEachChild(bindings);
  }
  bindings(source);
  function checkImport(specifier: string) {
    const target = modulePath(file, specifier);
    if (
      target &&
      adapterFiles.has(target) &&
      !adapterFiles.has(file) &&
      !compositionImports.get(file)?.has(target)
    ) {
      violations.push(`import ${specifier}`);
    }
  }
  function inspectImports(node: Node): void {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isStringLiteral(node.moduleSpecifier)
    ) {
      checkImport(node.moduleSpecifier.text);
    }
  }

  function inspectCall(node: CallExpression): void {
    const [first] = node.arguments;
    if (
      (node.expression.kind === SyntaxKind.ImportKeyword ||
        (isIdentifier(node.expression) && node.expression.text === "require")) &&
      first &&
      isStringLiteral(first)
    ) {
      checkImport(first.text);
    }
    let callee = "";
    if (isIdentifier(node.expression)) {
      callee = node.expression.text;
    } else if (isPropertyAccessExpression(node.expression)) {
      callee = node.expression.name.text;
    }
    if (
      !adapterFiles.has(file) &&
      file !== "src/cli/bootstrap-tmux.ts" &&
      subprocessNames.has(callee)
    ) {
      const text =
        first && (isStringLiteral(first) || isNoSubstitutionTemplateLiteral(first))
          ? first.text
          : "";
      if (/(?:^|[\s/])tmux(?:$|\s)/u.test(text)) {
        violations.push(`tmux subprocess ${node.expression.getText(source)}`);
      }
    }
  }

  function inspectNeutral(node: Node): void {
    if (
      !adapterFiles.has(file) &&
      (file.startsWith("src/components/") ||
        file.startsWith("src/hooks/") ||
        [
          "src/lib/service/manager.ts",
          "src/lib/task/runner.ts",
          "src/lib/request-context.ts",
        ].includes(file))
    ) {
      if (
        isCaseClause(node) &&
        isStringLiteral(node.expression) &&
        ["tmux", "shell"].includes(node.expression.text)
      ) {
        violations.push("backend-name operation branch");
      }
      if (isRegularExpressionLiteral(node) && /%|pane_id|window_id/u.test(node.text)) {
        violations.push("terminal ID parsing");
      }
      if (
        isBinaryExpression(node) &&
        [SyntaxKind.EqualsEqualsEqualsToken, SyntaxKind.ExclamationEqualsEqualsToken].includes(
          node.operatorToken.kind,
        )
      ) {
        const literals = [node.left, node.right].filter(isStringLiteral);
        if (literals.some((value) => value.text === "tmux" || value.text === "shell")) {
          violations.push("backend-name operation branch");
        }
      }
    }
  }
  function visit(node: Node): void {
    inspectImports(node);
    if (isCallExpression(node)) {
      inspectCall(node);
    }
    inspectNeutral(node);
    node.forEachChild(visit);
  }
  visit(source);
  return violations;
}

function withProgram<T>(
  action: (files: readonly string[], get: (file: string) => SourceFile) => T,
): T {
  const api = new API();
  const snapshot = api.updateSnapshot({ openProjects: [path.resolve("tsconfig.json")] });
  try {
    const project = snapshot.getProject(path.resolve("tsconfig.json"));
    if (!project) {
      throw new Error("Missing architecture project");
    }
    return action(project.program.getSourceFileNames(), (file) => {
      const source = project.program.getSourceFile(file);
      if (!source) {
        throw new Error(`Missing source: ${file}`);
      }
      return source;
    });
  } finally {
    snapshot.dispose();
    api.close();
  }
}

describe("backend architecture boundaries", () => {
  it("keeps core, request helpers and UI free of low-level terminal adapters", () => {
    const violations = withProgram((files, get) =>
      files
        .filter((file) => file.startsWith(path.resolve("src") + path.sep))
        .flatMap((file) => {
          const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
          return boundaryViolations(relative, get(file)).map(
            (message) => `${relative}: ${message}`,
          );
        }),
    );
    expect(violations).toEqual([]);
  });
  it("uses exact module allowances rather than directory exemptions", () => {
    expect([...compositionImports.keys()].every((file) => fs.statSync(file).isFile())).toBe(true);
    expect(adapterFiles.has("src/lib/backend/runtime/process-inspection.ts")).toBe(false);
    expect(compositionImports.has("src/daemon/session.ts")).toBe(false);
    withProgram((_files, get) => {
      const adapter = get(path.resolve("src/lib/backend/tmux/session.ts"));
      expect(boundaryViolations("src/lib/service/manager.ts", adapter)).not.toEqual([]);
      const factory = get(path.resolve("src/lib/backend/factory.ts"));
      expect(boundaryViolations("src/lib/task/runner.ts", factory)).toContain(
        "backend-name operation branch",
      );
      const subprocess = get(path.resolve("src/lib/tmux.ts"));
      expect(boundaryViolations("src/lib/request-context.ts", subprocess)).toContainEqual(
        expect.stringContaining("tmux subprocess"),
      );
    });
  });
});
