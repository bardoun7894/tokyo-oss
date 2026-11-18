import type { Request } from "express";

export const PROJECT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export interface PageQuery { limit: number; before?: number; since?: number }

const strParam = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function parseTime(v: string | undefined): number | undefined | null {
  if (v === undefined || v === "") return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** `limit` (1 to 100), `before` and `since` (ISO-8601). Returns an error message for a 400. */
export function parsePage(req: Request, defaultLimit: number): PageQuery | string {
  const rawLimit = strParam(req.query.limit);
  let limit = defaultLimit;
  if (rawLimit !== undefined) {
    if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) return "limit must be an integer from 1 to 100";
    limit = Number(rawLimit);
  }
  const before = parseTime(strParam(req.query.before));
  if (before === null) return "before must be an ISO-8601 timestamp";
  const since = parseTime(strParam(req.query.since));
  if (since === null) return "since must be an ISO-8601 timestamp";
  return { limit, ...(before !== undefined ? { before } : {}), ...(since !== undefined ? { since } : {}) };
}

/** Takes the newest `limit` of items already sorted newest first (one probe item may follow). `next` is the `before` value of the next page. */
export function pageOf<T>(items: T[], limit: number, createdAt: (t: T) => number): { page: T[]; next: string | null } {
  const page = items.slice(0, limit);
  return { page, next: items.length > limit ? new Date(createdAt(page[page.length - 1])).toISOString() : null };
}
