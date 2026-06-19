export const LOGO = `
 ███████╗  █████╗  ██████╗  ███████╗
 ╚══███╔╝ ██╔══██╗ ██╔══██╗ ██╔════╝
   ███╔╝  ███████║ ██████╔╝ ███████╗
  ███╔╝   ██╔══██║ ██╔═══╝  ╚════██║
 ███████╗ ██║  ██║ ██║      ███████║
 ╚══════╝ ╚═╝  ╚═╝ ╚═╝      ╚══════╝`.trimStart();

/** Strictly 7-bit splash art for the `ascii` icon tier (no box-drawing glyphs). */
export const LOGO_ASCII = `
 _____   _    ____  ____
|__  /  / \\  |  _ \\/ ___|
  / /  / _ \\ | |_) \\___ \\
 / /_ / ___ \\|  __/ ___) |
/____/_/   \\_\\_|   |____/`.trimStart();

/**
 * Write ANSI splash to stdout — visible while Ink loads.
 * Accepts optional tmux pane dimensions (process.stdout doesn't reflect pane height)
 * and the icon tier so the `ascii` tier renders 7-bit-safe art.
 */
export function renderSplash(
  size?: { cols: number; rows: number },
  tier?: "nerd" | "unicode" | "ascii",
): void {
  const rows = size?.rows || process.stdout.rows || 24;
  const cols = size?.cols || process.stdout.columns || 80;

  const lines = (tier === "ascii" ? LOGO_ASCII : LOGO).split("\n");
  const cyan = "\x1b[36m";
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const subtitle = "Starting services...";
  const maxWidth = Math.max(...lines.map((l) => l.length));
  const logoHeight = lines.length + 1; // +1 for subtitle
  const topPad = Math.max(0, Math.floor((rows - logoHeight) / 2));

  const leftPad = " ".repeat(Math.max(0, Math.floor((cols - maxWidth) / 2)));
  const subPad = " ".repeat(Math.max(0, Math.floor((cols - subtitle.length) / 2)));

  const buffer: string[] = Array.from({ length: rows }, () => "");

  for (let i = 0; i < lines.length; i += 1) {
    if (topPad + i < rows) {
      buffer[topPad + i] = `${leftPad}${cyan}${lines[i]}${reset}`;
    }
  }
  const subtitleRow = topPad + lines.length;
  if (subtitleRow < rows) {
    buffer[subtitleRow] = `${subPad}${dim}${subtitle}${reset}`;
  }

  const sizeLabel = `${cols}x${rows}`;
  buffer[rows - 1] =
    `${" ".repeat(Math.max(0, cols - sizeLabel.length))}${dim}${sizeLabel}${reset}`;

  process.stdout.write(`\x1b[H${buffer.join("\n")}`);
}
