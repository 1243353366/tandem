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
  /** Matches this identity had before the account was erased and remade. */
  carried_over: number;
};

export function matchQuota(db: Db, personId: string, now: Date = new Date()): Quota {
  const since = new Date(now.getTime() - MATCH_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT COALESCE(matched_at, created_at) AS at FROM matches
        WHERE (a_id = ? OR b_id = ?) AND COALESCE(matched_at, created_at) >= ?
        ORDER BY at ASC`,
    )
    .all(personId, personId, since) as Array<{ at: string }>;

  // An erased account that re-verifies the same phone does not get a fresh
  // fortnight. The hash of that phone is kept for exactly this reason.
  const carried = Number(
    (
      db
        .prepare(
          `SELECT COALESCE(MAX(r.matches_at_retirement), 0) AS n
             FROM retired_identities r
             JOIN consents c ON c.subject_hash = r.subject_hash AND c.kind = r.kind
            WHERE c.person_id = ? AND c.revoked_at IS NULL AND r.retired_at >= ?`,
        )
        .get(personId, since) as { n?: number } | undefined
    )?.n ?? 0,
  );

  const used = Math.max(rows.length, carried);
  const oldest = rows[0]?.at ?? null;
  return {
    limit: MATCH_LIMIT_PER_WINDOW,
    used,
    remaining: Math.max(0, MATCH_LIMIT_PER_WINDOW - used),
    window_days: MATCH_WINDOW_DAYS,
    frees_up_at: oldest ? new Date(new Date(oldest).getTime() + MATCH_WINDOW_DAYS * DAY_MS).toISOString() : null,
    carried_over: carried,
  };
}
