/**
 * Prepare per-platform npm packages for the native binary.
 *
 * For each target it creates `npm-platforms/<name>/` containing the built binary
 * (renamed to `zaps`) plus a minimal package.json carrying `os`/`cpu` so npm
 * installs only the package matching the consumer's machine. Also rewrites the
 * main package.json's optionalDependencies to the release version so they install
 * in lockstep.
 *
 * Binaries are read from `artifacts/<artifact>` (the release workflow's build
 * matrix uploads them there). Run after `npm version` has set the tag version.
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Platform {
  name: string;
  artifact: string;
  os: string;
  cpu: string;
}

const platforms: Platform[] = [
  { name: "@bosdev/zaps-linux-x64", artifact: "zaps-linux-x64", os: "linux", cpu: "x64" },
  { name: "@bosdev/zaps-linux-arm64", artifact: "zaps-linux-arm64", os: "linux", cpu: "arm64" },
  { name: "@bosdev/zaps-darwin-x64", artifact: "zaps-darwin-x64", os: "darwin", cpu: "x64" },
  { name: "@bosdev/zaps-darwin-arm64", artifact: "zaps-darwin-arm64", os: "darwin", cpu: "arm64" },
];

function resolveVersion(): string {
  const envVersion = process.env.ZAPS_VERSION;
  if (envVersion) {
    return envVersion;
  }
  const parsed: unknown = JSON.parse(readFileSync("./package.json", "utf8"));
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof parsed.version === "string"
  ) {
    return parsed.version;
  }
  throw new Error("Could not resolve version from ZAPS_VERSION or package.json");
}

const version = resolveVersion();
const artifactsDir = process.env.ARTIFACTS_DIR ?? "artifacts";
const outDir = "npm-platforms";

rmSync(outDir, { recursive: true, force: true });

for (const platform of platforms) {
  const dir = path.join(outDir, platform.artifact);
  mkdirSync(dir, { recursive: true });

  const binary = path.join(dir, "zaps");
  copyFileSync(path.join(artifactsDir, platform.artifact), binary);
  chmodSync(binary, 0o755);

  const pkg = {
    name: platform.name,
    version,
    description: `Native zaps binary for ${platform.os}-${platform.cpu}.`,
    license: "MIT",
    repository: { type: "git", url: "git+https://github.com/boshold/zaps.git" },
    os: [platform.os],
    cpu: [platform.cpu],
    files: ["zaps"],
    publishConfig: { access: "public" },
  };
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`prepared ${platform.name}@${version}`); // eslint-disable-line no-console -- build script output
}

// Sync the main package's optionalDependencies to the release version.
const mainPkg: unknown = JSON.parse(readFileSync("./package.json", "utf8"));
if (typeof mainPkg !== "object" || mainPkg === null) {
  throw new Error("package.json is not an object");
}
const optionalDependencies: Record<string, string> = {};
for (const platform of platforms) {
  optionalDependencies[platform.name] = version;
}
const updated = { ...mainPkg, optionalDependencies };
writeFileSync("./package.json", `${JSON.stringify(updated, null, 2)}\n`);
console.log(`synced main optionalDependencies to ${version}`); // eslint-disable-line no-console -- build script output
