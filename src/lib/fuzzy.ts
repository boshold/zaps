import { go } from "fuzzysort";

/** A ranked match: the original item, its score, and the matched character indexes. */
interface FuzzyMatch<T> {
  /** The original item from the input list. */
  item: T;
  /** Match score from fuzzysort — `1` is a perfect match, `0` no match. `0` for empty-query passthrough. */
  score: number;
  /** Ascending indexes into the key string that matched, for highlight spans. Empty when none. */
  indexes: number[];
}

interface FuzzyOptions {
  /** Cap the number of returned matches (lower is faster). */
  limit?: number;
  /** Drop matches scoring below this (higher is faster). */
  threshold?: number;
}

/**
 * Thin, generic wrapper over `fuzzysort.go` for the command palette and task
 * picker. Ranks `items` against `query` by the string returned from `keyFn`,
 * best first. An empty (or whitespace-only) query returns every item in its
 * original order with no highlights — the "show everything" idle state.
 */
function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  keyFn: (item: T) => string,
  options: FuzzyOptions = {},
): FuzzyMatch<T>[] {
  const trimmed = query.trim();

  if (trimmed === "") {
    const passthrough = items.map((item) => ({ item, score: 0, indexes: [] as number[] }));
    return options.limit === undefined ? passthrough : passthrough.slice(0, options.limit);
  }

  const results = go(trimmed, items, {
    key: keyFn,
    limit: options.limit,
    threshold: options.threshold,
  });

  return results.map((result) => ({
    item: result.obj,
    score: result.score,
    // Copy + sort: highlight spans must be ascending; fuzzysort's order isn't guaranteed.
    indexes: result.indexes.toSorted((a, b) => a - b),
  }));
}

export { fuzzyRank };
export type { FuzzyMatch, FuzzyOptions };
