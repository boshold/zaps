/**
 * Longest tail of `prev` that equals the head of `current`, or null if none.
 */
function overlapLength(prev: string[], current: string[]): number | null {
  for (let overlap = Math.min(prev.length, current.length); overlap > 0; overlap -= 1) {
    let match = true;
    for (let i = 0; i < overlap; i += 1) {
      if (prev[prev.length - overlap + i] !== current[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return overlap;
    }
  }
  return null;
}

function insertedIntoPadding(prev: string[], current: string[]): string[] | null {
  if (prev.length !== current.length) {
    return null;
  }
  let prefix = 0;
  while (prefix < prev.length && prev[prefix] === current[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < prev.length - prefix &&
    prev[prev.length - suffix - 1] === current[current.length - suffix - 1]
  ) {
    suffix += 1;
  }
  if (prefix === 0 || suffix === 0) {
    return null;
  }
  const removed = prev.slice(prefix, prev.length - suffix);
  const inserted = current.slice(prefix, current.length - suffix);
  const retainedFooter = prev.slice(prev.length - suffix);
  return removed.length > 0 &&
    removed.every((line) => line.trim() === "") &&
    inserted.some((line) => line.trim() !== "") &&
    retainedFooter.some((line) => line.trim() !== "")
    ? inserted
    : null;
}

/**
 * Find new lines between two pane captures using line-overlap diffing.
 *
 * 1. Direct overlap on the full captures handles scrolling and plain appends.
 * 2. If that fails, retry with each capture's final line excluded: tmux may be
 *    rewriting it in place (progress bars, status lines), which would otherwise
 *    desync the search and re-emit the whole window (C6). Only the stable lines
 *    are returned; the volatile final line is held until a newer line appears.
 * 3. An unchanged prefix/footer can delimit logs consuming blank viewport padding.
 * 4. With no alignment, equal-size windows are the same buffer rewritten —
 *    prefer reporting nothing over re-emitting everything (C6).
 */
function diffOutput(prev: string[], current: string[]): string[] {
  // No baseline yet — everything is new.
  if (prev.length === 0) {
    return current;
  }

  const direct = overlapLength(prev, current);
  if (direct !== null) {
    return current.slice(direct);
  }

  const prevStable = prev.slice(0, -1);
  const currStable = current.slice(0, -1);
  const stable = overlapLength(prevStable, currStable);
  if (stable !== null) {
    return currStable.slice(stable);
  }

  return insertedIntoPadding(prev, current) ?? (prev.length === current.length ? [] : current);
}

export { diffOutput };
