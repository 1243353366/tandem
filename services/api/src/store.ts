/**
 * Data access. All SQL lives here so route handlers stay readable.
 */

import { audit, isoIn, nowIso, parseJson } from "./db.ts";
import type { Db } from "./db.ts";
import { newId } from "./crypto.ts";

export type PersonRow = {
  id: string;
  display_name: string;
  headline: string;
  location_city: string;
  location_region: string;
  location_country: string;
  timezone: string;
  interests: string;
  current_project: string;
  project_tags: string;
  hours_per_week: number;
  looking_for: string;
  offers: string;
  comm_style: string;
  visibility: string;
  status: string;
  api_token_hash: string;
  created_at: string;
  updated_at: string;
};

export type ConsentRow = {
  id: string;
  person_id: string;
  kind: string;
  subject_hash: string;
  subject_hint: string;
  scope: string;
  policy_version: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  receipt_hash: string;
  evidence: string;
};

const PERSON_COLUMNS = [
  "display_name",
  "headline",
  "location_city",
  "location_region",
  "location_country",
  "timezone",
  "interests",
  "current_project",
  "project_tags",
  "hours_per_week",
  "looking_for",
  "offers",
  "comm_style",
  "visibility",
] as const;

/** Serialize a validated profile object into column values. */
function columnsFrom(value: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const column of PERSON_COLUMNS) {
    if (!(column in value)) continue;
    const raw = value[column];
    if (column === "hours_per_week") out[column] = Number(raw) || 0;
    else if (column === "interests" || column === "project_tags" || column === "looking_for" || column === "offers") {
      out[column] = JSON.stringify(raw ?? []);
    } else if (column === "comm_style") out[column] = JSON.stringify(raw ?? {});
    else out[column] = String(raw ?? "");
  }
  return out;
}

/** Public JSON view of a person. Never includes the token hash. */
export function personView(row: PersonRow, liveConsents: ConsentRow[] = []) {
  return {
    id: row.id,
    display_name: row.display_name,
    headline: row.headline,
    location: {
      city: row.location_city,
      region: row.location_region,
      country: row.location_country,
    },
    timezone: row.timezone,
    interests: parseJson<string[]>(row.interests, []),
    current_project: row.current_project,
    project_tags: parseJson<string[]>(row.project_tags, []),
    hours_per_week: row.hours_per_week,
    looking_for: parseJson<string[]>(row.looking_for, []),
    offers: parseJson<string[]>(row.offers, []),
    comm_style: parseJson<Record<string, unknown>>(row.comm_style, {}),
    visibility: row.visibility,
    status: row.status,
    verified: liveConsents.length > 0,
    verified_channels: liveConsents.map((c) => c.kind),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Shape handed to the Python matcher. */
export function matcherPayload(
  row: PersonRow,
  liveConsents: ConsentRow[],
  observed: string[] = [],
) {
  return {
    id: row.id,
    display_name: row.display_name,
    timezone: row.timezone,
    interests: parseJson<string[]>(row.interests, []),
    project_tags: parseJson<string[]>(row.project_tags, []),
    // Tags derived from the person's own declared handles. Declared interests win
    // in the engine; these only break ties, because what you say should outrank
    // what your commits imply.
    observed_interests: observed,
    current_project: row.current_project,
    hours_per_week: row.hours_per_week,
    looking_for: parseJson<string[]>(row.looking_for, []),
    offers: parseJson<string[]>(row.offers, []),
    comm_style: parseJson<Record<string, unknown>>(row.comm_style, {}),
    visibility: row.visibility,
    verified: liveConsents.length > 0,
  };
}

export function createPerson(
  db: Db,
  value: Record<string, unknown>,
  tokenHash: string,
): PersonRow {
  const id = newId();
  const now = nowIso();
  const cols = columnsFrom(value);
  const names = ["id", ...Object.keys(cols), "api_token_hash", "created_at", "updated_at"];
  const values = [id, ...Object.values(cols), tokenHash, now, now];
  db.prepare(
    `INSERT INTO people (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...values);
  audit(db, id, "person.created", null, {});
  return getPerson(db, id)!;
}

export function updatePerson(db: Db, id: string, value: Record<string, unknown>): PersonRow | null {
  const cols = columnsFrom(value);
  const names = Object.keys(cols);
  if (names.length === 0) return getPerson(db, id);
  const assignments = names.map((name) => `${name} = ?`).join(", ");
  db.prepare(`UPDATE people SET ${assignments}, updated_at = ? WHERE id = ?`).run(
    ...Object.values(cols),
    nowIso(),
    id,
  );
  audit(db, id, "person.updated", null, { fields: names });
  return getPerson(db, id);
}

export function getPerson(db: Db, id: string): PersonRow | null {
  const row = db.prepare("SELECT * FROM people WHERE id = ?").get(id) as PersonRow | undefined;
  return row ?? null;
}

export function getPersonByTokenHash(db: Db, tokenHash: string): PersonRow | null {
  const row = db
    .prepare("SELECT * FROM people WHERE api_token_hash = ? AND status != 'erased'")
    .get(tokenHash) as PersonRow | undefined;
  return row ?? null;
}

export function listSearchable(db: Db): PersonRow[] {
  return db
    .prepare("SELECT * FROM people WHERE visibility = 'searchable' AND status = 'active'")
    .all() as unknown as PersonRow[];
}

export function countPeople(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM people WHERE status = 'active'").get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/**
 * Erasure. Rows cascade (consents, proofs, challenges, signals, matches), and
 * we keep one audit line with no identifiers in it so the deletion itself is
 * accountable without being a record of who was deleted.
 */
/**
 * Erase means erase. Every descriptive column is emptied, every derived table is
 * cleared, and the only thing kept is a hash of each verified identifier with the
 * number of matches it had in the current window. That hash already existed as a
 * consent subject; it carries no name, location or interest, and without it an
 * erase-and-return cycle would reset the two-a-fortnight cap and recycle a phone
 * number into a fresh identity.
 */
export function erasePerson(db: Db, id: string): void {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const used = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM matches
            WHERE (a_id = ? OR b_id = ?) AND COALESCE(matched_at, created_at) >= ?`,
        )
        .get(id, id, since) as { n?: number } | undefined
    )?.n ?? 0,
  );
  const subjects = db
    .prepare("SELECT kind, subject_hash FROM consents WHERE person_id = ? AND revoked_at IS NULL")
    .all(id) as Array<{ kind: string; subject_hash: string }>;

  db.exec("BEGIN");
  try {
    for (const subject of subjects) {
      db.prepare(
        `INSERT INTO retired_identities (id, kind, subject_hash, matches_at_retirement, retired_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(newId(), subject.kind, subject.subject_hash, used, nowIso());
    }
    db.prepare(
      `UPDATE people SET
         status = 'erased',
         display_name = '[erased]',
         headline = '',
         location_city = '',
         location_region = '',
         location_country = '',
         timezone = '',
         interests = '[]',
         current_project = '',
         project_tags = '[]',
         hours_per_week = 0,
         looking_for = '[]',
         offers = '[]',
         comm_style = '{}',
         visibility = 'hidden',
         updated_at = ?
       WHERE id = ?`,
    ).run(nowIso(), id);
    db.prepare("DELETE FROM signals WHERE person_id = ?").run(id);
    db.prepare("DELETE FROM social_proofs WHERE person_id = ?").run(id);
    db.prepare("DELETE FROM consents WHERE person_id = ?").run(id);
    db.prepare("DELETE FROM phone_challenges WHERE person_id = ?").run(id);
    db.prepare("DELETE FROM matches WHERE a_id = ? OR b_id = ?").run(id, id);
    // Introductions and declared handles point at the person, so they go too.
    // Leaving either behind would leave a public thread URL naming someone who left.
    db.prepare("DELETE FROM intros WHERE a_id = ? OR b_id = ? OR proposed_by = ?").run(id, id, id);
    db.prepare("DELETE FROM declared_handles WHERE person_id = ?").run(id);
    audit(db, id, "person.erased", null, { kept: "identifier hashes and match count only" });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ------------------------------------------------------------- consents ----

export function liveConsents(db: Db, personId: string): ConsentRow[] {
  return db
    .prepare(
      `SELECT * FROM consents
        WHERE person_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(personId, nowIso()) as unknown as ConsentRow[];
}

export function allConsents(db: Db, personId: string): ConsentRow[] {
  return db
    .prepare("SELECT * FROM consents WHERE person_id = ? ORDER BY granted_at DESC")
    .all(personId) as unknown as ConsentRow[];
}

export function consentView(row: ConsentRow) {
  return {
    id: row.id,
    kind: row.kind,
    subject_hint: row.subject_hint,
    scope: parseJson<string[]>(row.scope, []),
    policy_version: row.policy_version,
    granted_at: row.granted_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    status: row.revoked_at ? "revoked" : "active",
    receipt_hash: row.receipt_hash,
  };
}

export function findLiveConsentBySubject(
  db: Db,
  kind: string,
  subjectHash: string,
): ConsentRow | null {
  const row = db
    .prepare(
      `SELECT * FROM consents
        WHERE kind = ? AND subject_hash = ? AND revoked_at IS NULL`,
    )
    .get(kind, subjectHash) as ConsentRow | undefined;
  return row ?? null;
}

export function insertConsent(
  db: Db,
  values: {
    personId: string;
    kind: string;
    subjectHash: string;
    subjectHint: string;
    scope: string[];
    policyVersion: string;
    expiresAt: string | null;
    receiptHash: string;
    evidence: Record<string, unknown>;
  },
): ConsentRow {
  const id = newId();
  db.prepare(
    `INSERT INTO consents
       (id, person_id, kind, subject_hash, subject_hint, scope, policy_version,
        granted_at, expires_at, revoked_at, receipt_hash, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    values.personId,
    values.kind,
    values.subjectHash,
    values.subjectHint,
    JSON.stringify(values.scope),
    values.policyVersion,
    nowIso(),
    values.expiresAt,
    values.receiptHash,
    JSON.stringify(values.evidence),
  );
  audit(db, values.personId, "consent.granted", values.subjectHash, { kind: values.kind });
  return db.prepare("SELECT * FROM consents WHERE id = ?").get(id) as unknown as ConsentRow;
}

/**
 * Revocation is a single transaction: the consent dies, and everything derived
 * from it dies with it. A revocation that leaves signals behind is not a
 * revocation, it is a UI change.
 */
export function revokeConsent(db: Db, personId: string, consentId: string): boolean {
  const row = db
    .prepare("SELECT * FROM consents WHERE id = ? AND person_id = ?")
    .get(consentId, personId) as ConsentRow | undefined;
  if (!row) return false;
  if (row.revoked_at) return true;
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE consents SET revoked_at = ? WHERE id = ?").run(nowIso(), consentId);
    db.prepare("DELETE FROM signals WHERE consent_id = ?").run(consentId);
    // A revoked phone means the account is no longer identity-verified.
    if (row.kind === "phone") {
      db.prepare("DELETE FROM phone_challenges WHERE person_id = ?").run(personId);
    }
    audit(db, personId, "consent.revoked", row.subject_hash, { kind: row.kind });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

// ----------------------------------------------------------- challenges ----

export function recentChallengeCount(db: Db, personId: string, windowSeconds = 3600): number {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM phone_challenges WHERE person_id = ? AND created_at > ?")
    .get(personId, since) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function recentChallengeCountForOrigin(db: Db, origin: string, windowSeconds = 3600): number {
  if (!origin) return 0;
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM phone_challenges WHERE requested_from = ? AND created_at > ?")
    .get(origin, since) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function createChallenge(
  db: Db,
  values: {
    phoneHash: string;
    phoneHint: string;
    codeHash: string;
    salt: string;
    ttlSeconds: number;
    personId: string;
    requestedFrom?: string;
  },
): { id: string; expiresAt: string } {
  const id = newId();
  const expiresAt = isoIn(values.ttlSeconds);
  db.prepare(
    `INSERT INTO phone_challenges
       (id, phone_hash, phone_hint, code_hash, salt, attempts, created_at, expires_at, consumed_at, person_id, requested_from)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    values.phoneHash,
    values.phoneHint,
    values.codeHash,
    values.salt,
    nowIso(),
    expiresAt,
    values.personId,
    values.requestedFrom ?? "",
  );
  return { id, expiresAt };
}

export function getChallenge(db: Db, id: string) {
  return db.prepare("SELECT * FROM phone_challenges WHERE id = ?").get(id) as
    | {
        id: string;
        phone_hash: string;
        phone_hint: string;
        code_hash: string;
        salt: string;
        attempts: number;
        created_at: string;
        expires_at: string;
        consumed_at: string | null;
        person_id: string | null;
      }
    | undefined;
}

export function bumpChallengeAttempts(db: Db, id: string): void {
  db.prepare("UPDATE phone_challenges SET attempts = attempts + 1 WHERE id = ?").run(id);
}

export function consumeChallenge(db: Db, id: string): void {
  db.prepare("UPDATE phone_challenges SET consumed_at = ? WHERE id = ?").run(nowIso(), id);
}

export function purgeExpiredChallenges(db: Db): number {
  const result = db.prepare("DELETE FROM phone_challenges WHERE expires_at < ?").run(nowIso());
  return Number(result.changes ?? 0);
}

// -------------------------------------------------------------- proofs ----

export function createProof(
  db: Db,
  values: { personId: string; network: string; handle: string; nonce: string; ttlSeconds: number },
): { id: string; expiresAt: string } {
  const id = newId();
  const expiresAt = isoIn(values.ttlSeconds);
  db.prepare(
    `INSERT INTO social_proofs (id, person_id, network, handle, nonce, status, evidence_url, created_at, verified_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)`,
  ).run(id, values.personId, values.network, values.handle, values.nonce, nowIso(), expiresAt);
  return { id, expiresAt };
}

export function getProof(db: Db, id: string) {
  return db.prepare("SELECT * FROM social_proofs WHERE id = ?").get(id) as
    | {
        id: string;
        person_id: string;
        network: string;
        handle: string;
        nonce: string;
        status: string;
        evidence_url: string | null;
        created_at: string;
        verified_at: string | null;
        expires_at: string;
      }
    | undefined;
}

export function resolveProof(
  db: Db,
  id: string,
  status: "verified" | "failed" | "expired",
  evidenceUrl: string | null,
): void {
  db.prepare("UPDATE social_proofs SET status = ?, evidence_url = ?, verified_at = ? WHERE id = ?").run(
    status,
    evidenceUrl,
    status === "verified" ? nowIso() : null,
    id,
  );
}

// ------------------------------------------------------------- matches ----

export function recordMatch(
  db: Db,
  values: {
    aId: string;
    bId: string;
    score: number;
    breakdown: unknown;
    reasons: unknown;
    blockers: unknown;
    engineVersion: string;
  },
): void {
  const [a, b] = values.aId < values.bId ? [values.aId, values.bId] : [values.bId, values.aId];
  db.prepare(
    `INSERT INTO matches (id, a_id, b_id, score, score_breakdown, reasons, blockers, engine_version, created_at, matched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(a_id, b_id) DO UPDATE SET
       score = excluded.score,
       score_breakdown = excluded.score_breakdown,
       reasons = excluded.reasons,
       blockers = excluded.blockers,
       engine_version = excluded.engine_version,
       created_at = excluded.created_at`,
  ).run(
    newId(),
    a,
    b,
    values.score,
    JSON.stringify(values.breakdown),
    JSON.stringify(values.reasons),
    JSON.stringify(values.blockers),
    values.engineVersion,
    nowIso(),
    nowIso(),
  );
}
