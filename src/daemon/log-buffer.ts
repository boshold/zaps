/**
 * Ring buffer for service log lines.
 * Stores the last N lines and provides snapshot + append.
 */
export class LogBuffer {
  private buffer: string[];
  private head = 0;
  private count = 0;
  private readonly capacity: number;

  constructor(capacity = 10_000) {
    this.capacity = capacity;
    this.buffer = Array.from<string>({ length: capacity });
  }

  append(line: string): void {
    this.buffer[this.head] = line;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count += 1;
    }
  }

  appendLines(lines: string[]): void {
    for (const line of lines) {
      this.append(line);
    }
  }

  snapshot(): string[] {
    if (this.count === 0) {
      return [];
    }
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count);
    }
    // Wrapped: tail starts at head (oldest), wraps around
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)];
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  get length(): number {
    return this.count;
  }
}
