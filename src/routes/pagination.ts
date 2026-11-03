import type { Request, Response } from "express";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_OFFSET = 100_000;

export interface OffsetPage {
  limit: number;
  offset: number;
}

function parseInteger(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseOffsetPage(query: Request["query"]): OffsetPage | null {
  const limit =
    query.limit === undefined ? DEFAULT_LIMIT : parseInteger(query.limit);
  const offset =
    query.offset === undefined ? 0 : parseInteger(query.offset);
  if (
    limit === null ||
    offset === null ||
    limit < 1 ||
    limit > MAX_LIMIT ||
    offset > MAX_OFFSET
  ) {
    return null;
  }
  return { limit, offset };
}

export function setPaginationHeaders(
  res: Response,
  page: OffsetPage,
  hasMore: boolean,
): void {
  res.setHeader("X-Page-Limit", String(page.limit));
  res.setHeader("X-Has-More", String(hasMore));
  if (hasMore) {
    res.setHeader("X-Next-Offset", String(page.offset + page.limit));
  }
}
