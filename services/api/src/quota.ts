/**
 * Two matches a fortnight, enforced here rather than in the operator's head.
 *
 * Scarcity is the product decision that turns a ranked list into an
 * introduction. A person who can request twenty matches will treat all twenty
 * as optional; a person with two will answer one.
 */

import type { Db } from "./db.ts";

export const MATCH_WINDOW_DAYS = 14;
export const MATCH_LIMIT_PER_WINDOW = 2;

const DAY_MS = 86_400_000;

export type Quota = {
  limit: number;
  used: number;
  remaining: number;
  window_days: number;
  /** When the oldest match in the window falls out of it, freeing one slot. */
  frees_up_at: string | null;
};

export function matchQuota(db: Db, personId: string, now: Date = new Date()): Quota {
  const since = new Date(now.getTime() - MATCH_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT created_at FROM matches
        WHERE (a_id = ? OR b_id = ?) AND created_at >= ?
        ORDER BY created_at ASC`,
    )
    .all(personId, personId, since) as Array<{ created_at: string }>;

  const oldest = rows[0]?.created_at ?? null;
  return {
    limit: MATCH_LIMIT_PER_WINDOW,
    used: rows.length,
    remaining: Math.max(0, MATCH_LIMIT_PER_WINDOW - rows.length),
    window_days: MATCH_WINDOW_DAYS,
    frees_up_at: oldest ? new Date(new Date(oldest).getTime() + MATCH_WINDOW_DAYS * DAY_MS).toISOString() : null,
  };
}
