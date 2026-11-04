import type { Db } from "./db.ts";

/**
 * The unit of scarcity is the introduction, not the browse.
 *
 * The cap used to count matches revealed, which meant looking at who was available
 * spent your fortnight even if you never wrote to anyone. The product promises
 * introductions, so introductions are what is counted. Browsing is limited
 * separately and generously, because an unlimited browse would let one person
 * enumerate the cohort.
 */
export const INTRO_LIMIT_PER_WINDOW = 2;
export const MATCH_WINDOW_DAYS = 14;
export const REVEALS_PER_DAY = 10;

const DAY_MS = 86_400_000;

export type Quota = {
  unit: "introductions";
  limit: number;
  used: number;
  remaining: number;
  window_days: number;
  /** When the oldest introduction in the window falls out of it, freeing a slot. */
  frees_up_at: string | null;
  /** Introductions this identity had before the account was erased and remade. */
  carried_over: number;
  reveals_today: number;
  reveals_remaining_today: number;
};

export function matchQuota(db: Db, personId: string, now: Date = new Date()): Quota {
  const since = new Date(now.getTime() - MATCH_WINDOW_DAYS * DAY_MS).toISOString();

  const rows = db
    .prepare(
      `SELECT proposed_at AS at FROM intros
        WHERE (a_id = ? OR b_id = ?) AND proposed_at >= ?
        ORDER BY proposed_at ASC`,
    )
    .all(personId, personId, since) as Array<{ at: string }>;

  // An erased account that re-verifies the same phone does not get a fresh
  // fortnight. The hash of that phone is kept for exactly this reason.
  const carried = Number(
    (
      db
        .prepare(
          `SELECT COALESCE(MAX(COALESCE(r.count_at_retirement, r.matches_at_retirement)), 0) AS n
             FROM retired_identities r
             JOIN consents c ON c.subject_hash = r.subject_hash AND c.kind = r.kind
            WHERE c.person_id = ? AND c.revoked_at IS NULL AND r.retired_at >= ?`,
        )
        .get(personId, since) as { n?: number } | undefined
    )?.n ?? 0,
  );

  const reveals = revealCount(db, personId, now);
  const used = Math.max(rows.length, carried);
  const oldest = rows[0]?.at ?? null;

  return {
    unit: "introductions",
    limit: INTRO_LIMIT_PER_WINDOW,
    used,
    remaining: Math.max(0, INTRO_LIMIT_PER_WINDOW - used),
    window_days: MATCH_WINDOW_DAYS,
    frees_up_at: oldest
      ? new Date(new Date(oldest).getTime() + MATCH_WINDOW_DAYS * DAY_MS).toISOString()
      : null,
    carried_over: carried,
    reveals_today: reveals,
    reveals_remaining_today: Math.max(0, REVEALS_PER_DAY - reveals),
  };
}

/** Distinct people shown in the last day, which is what a browse limit protects. */
export function revealCount(db: Db, personId: string, now: Date = new Date()): number {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM matches
        WHERE (a_id = ? OR b_id = ?) AND COALESCE(matched_at, created_at) >= ?`,
    )
    .get(personId, personId, dayAgo) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

