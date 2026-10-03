import {
  SentraValidationError,
  formatFrameLocation,
  renderIssueDetail,
  renderItemDetail,
} from "@boshold/sentra-core";
import type {
  Frame,
  Issue,
  IssueFilter,
  Item,
  ItemFilter,
  ItemSummary,
  Page,
  PageInput,
  Sentra,
} from "@boshold/sentra-core";

import { DEFAULT_LIMIT, MAX_LIMIT } from "./schemas.js";
import type {
  ClearParams,
  ClearResult,
  ErrorRow,
  ErrorsParams,
  ErrorsResult,
  IssueRow,
  IssuesParams,
  IssuesResult,
  ShowResult,
} from "./schemas.js";
import { SentraQueryError, parseTimeInput, resolveTimeWindow } from "./time.js";

/** Max records walked per query (`skip + limit + 1`). */
const MAX_WALK = 5000;

const EVENT_ID = /^[0-9a-f]{32}$/i;
const EVENT_KIND_RANK: Record<string, number> = { error: 0, message: 1, transaction: 2 };

type SentraQuerySource = Pick<Sentra, "query" | "clear">;

async function mapValidation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SentraValidationError) {
      throw new SentraQueryError("invalid_filter", error.message);
    }
    throw error;
  }
}

function nonEmpty<T>(values: T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

async function walk<T>(
  fetchPage: (page: PageInput) => Promise<Page<T>>,
  skip: number,
  limit: number,
): Promise<{ rows: T[]; hasMore: boolean }> {
  const want = skip + limit + 1;
  if (want > MAX_WALK) {
    throw new SentraQueryError(
      "invalid_filter",
      `--skip too large: --skip + --limit must be below ${MAX_WALK}.`,
    );
  }
  const seen: T[] = [];
  let cursor: string | undefined = undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- cursors are sequential
    const page = await mapValidation(async () =>
      fetchPage({ limit: Math.min(MAX_LIMIT, want - seen.length), cursor }),
    );
    seen.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (seen.length < want && cursor !== undefined);
  return { rows: seen.slice(skip, skip + limit), hasMore: seen.length > skip + limit };
}

function crashFrames(item: Item): Frame[] {
  if (item.kind === "error") {
    return item.data.exceptions.at(-1)?.frames ?? item.data.stacktrace;
  }
  if (item.kind === "message") {
    return item.data.stacktrace;
  }
  return [];
}

/** Prefers error/message/transaction, like `getItemByEventId`, but scoped to the session. */
async function findByEventId(
  sentra: SentraQuerySource,
  sessionId: string,
  eventId: string,
): Promise<Item | null> {
  const page = await sentra.query.listItems(
    { session: sessionId, eventId: eventId.toLowerCase() },
    { limit: 50 },
  );
  const [best] = page.items.toSorted(
    (a, b) => (EVENT_KIND_RANK[a.kind] ?? 9) - (EVENT_KIND_RANK[b.kind] ?? 9),
  );
  return best ? sentra.query.getItem(best.id) : null;
}

/** Crashing frame as sentra-core picks it: newest in-app, else newest; `""` if none. */
export function itemLocation(item: Item | null): string {
  if (!item) {
    return "";
  }
  const frames = crashFrames(item);
  const frame = frames.findLast((candidate) => candidate.inApp) ?? frames.at(-1);
  return frame ? formatFrameLocation(frame) : "";
}

export function toErrorRow(summary: ItemSummary, location: string): ErrorRow {
  return {
    id: summary.id,
    receivedAt: summary.receivedAt,
    service: summary.scope.service,
    kind: summary.kind,
    level: summary.level,
    title: summary.title,
    location,
    issueId: summary.issueId,
  };
}

export function toIssueRow(issue: Issue): IssueRow {
  return {
    id: issue.id,
    shortId: issue.shortId,
    services: issue.services.join(","),
    level: issue.level,
    title: issue.title,
    culprit: issue.culprit,
    count: issue.count,
    firstSeen: issue.firstSeenAt,
    lastSeen: issue.lastSeenAt,
  };
}

export function buildItemFilter(params: ErrorsParams, now = Date.now()): ItemFilter {
  const noLevelFlags =
    params.kind === undefined && params.level === undefined && params.minLevel === undefined;
  return {
    session: params.sessionId,
    service: nonEmpty(params.service),
    kind: nonEmpty(params.kind) ?? ["error", "message"],
    level: nonEmpty(params.level),
    minLevel: params.minLevel ?? (noLevelFlags ? "error" : undefined),
    q: params.q,
    release: params.release,
    environment: params.environment,
    traceId: params.traceId,
    ...resolveTimeWindow(params, now),
  };
}

export function buildIssueFilter(params: IssuesParams, now = Date.now()): IssueFilter {
  return {
    session: params.sessionId,
    service: nonEmpty(params.service),
    level: nonEmpty(params.level),
    minLevel: params.minLevel,
    q: params.q,
    ...resolveTimeWindow(params, now),
  };
}

export async function listErrors(
  sentra: SentraQuerySource,
  params: ErrorsParams,
): Promise<ErrorsResult> {
  const filter = buildItemFilter(params);
  const { rows, hasMore } = await walk(
    async (page) => sentra.query.listItems(filter, page),
    params.skip ?? 0,
    params.limit ?? DEFAULT_LIMIT,
  );
  const errors = await Promise.all(
    rows.map(async (row) => toErrorRow(row, itemLocation(await sentra.query.getItem(row.id)))),
  );
  return { errors, hasMore };
}

export async function listIssues(
  sentra: SentraQuerySource,
  params: IssuesParams,
): Promise<IssuesResult> {
  const filter = buildIssueFilter(params);
  const { rows, hasMore } = await walk(
    async (page) => sentra.query.listIssues(filter, page),
    params.skip ?? 0,
    params.limit ?? DEFAULT_LIMIT,
  );
  return { issues: rows.map(toIssueRow), hasMore };
}

/** Resolves an item id, issue id, or Sentry event id within one session. */
export async function showById(
  sentra: SentraQuerySource,
  sessionId: string,
  id: string,
): Promise<ShowResult> {
  return mapValidation(async () => {
    const item = await sentra.query.getItem(id);
    if (item?.scope.session === sessionId) {
      return { type: "item", item, markdown: renderItemDetail(item) };
    }
    const issue = await sentra.query.getIssue(id);
    if (issue?.session === sessionId) {
      return { type: "issue", issue, markdown: renderIssueDetail(issue, new Date()) };
    }
    if (EVENT_ID.test(id)) {
      const byEvent = await findByEventId(sentra, sessionId, id);
      if (byEvent) {
        return { type: "item", item: byEvent, markdown: renderItemDetail(byEvent) };
      }
    }
    throw new SentraQueryError(
      "not_found",
      `No Sentra record or issue "${id}" in session ${sessionId}.`,
    );
  });
}

export async function clearSession(
  sentra: SentraQuerySource,
  params: ClearParams,
): Promise<ClearResult> {
  const filter: ItemFilter = { session: params.sessionId, service: nonEmpty(params.service) };
  if (params.to !== undefined) {
    filter.to = parseTimeInput(params.to, "before");
  }
  return mapValidation(async () => sentra.clear(filter));
}

export { MAX_WALK, SentraQueryError };
export type { SentraQuerySource };
