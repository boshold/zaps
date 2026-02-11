import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function writeComposeFile(
  tmpDir: string,
  services: Record<string, { image: string; ports?: string[] }>,
): Promise<string> {
  const svcEntries = Object.entries(services).map(([name, cfg]) => {
    let block = `    ${name}:\n      image: ${cfg.image}`;
    if (cfg.ports && cfg.ports.length > 0) {
      block += `\n      ports:\n${cfg.ports.map((p) => `        - "${p}"`).join("\n")}`;
    }
    return block;
  });

  const content = `services:\n${svcEntries.join("\n")}`;
  const filePath = path.join(tmpDir, "docker-compose.yml");
  await writeFile(filePath, content, "utf8");
  return filePath;
}

export async function composeDown(tmpDir: string, file?: string): Promise<void> {
  const args = ["compose"];
  if (file) {
    args.push("-f", file);
  }
  args.push("down", "--remove-orphans", "-t", "5");
  try {
    await execFileAsync("docker", args, { cwd: tmpDir });
  } catch {
    // Best-effort cleanup
  }
}
