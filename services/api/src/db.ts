/**
 * Storage.
 *
 * SQLite via Node's built-in `node:sqlite` so the whole stack runs with zero
 * installed dependencies. The schema mirrors `db/001_init.sql` (Postgres).
 * Pointing this at Postgres later means swapping this module, not the routes.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

const SCHEMA = [
  `PRAGMA foreign_keys = ON`,
  `PRAGMA journal_mode = WAL`,
  `CREATE TABLE IF NOT EXISTS people (
     id TEXT PRIMARY KEY,
     display_name TEXT NOT NULL,
     headline TEXT NOT NULL DEFAULT '',
     location_city TEXT NOT NULL DEFAULT '',
     location_region TEXT NOT NULL DEFAULT '',
     location_country TEXT NOT NULL DEFAULT '',
     timezone TEXT NOT NULL DEFAULT '',
     interests TEXT NOT NULL DEFAULT '[]',
     current_project TEXT NOT NULL DEFAULT '',
     project_tags TEXT NOT NULL DEFAULT '[]',
     hours_per_week INTEGER NOT NULL DEFAULT 0,
     looking_for TEXT NOT NULL DEFAULT '[]',
     offers TEXT NOT NULL DEFAULT '[]',
     comm_style TEXT NOT NULL DEFAULT '{}',
     visibility TEXT NOT NULL DEFAULT 'searchable',
     status TEXT NOT NULL DEFAULT 'active',
     api_token_hash TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS people_searchable ON people (visibility, status)`,
  `CREATE TABLE IF NOT EXISTS consents (
     id TEXT PRIMARY KEY,
     person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     subject_hash TEXT NOT NULL,
     subject_hint TEXT NOT NULL DEFAULT '',
     scope TEXT NOT NULL,
     policy_version TEXT NOT NULL,
     granted_at TEXT NOT NULL,
     expires_at TEXT,
     revoked_at TEXT,
     receipt_hash TEXT NOT NULL,
     evidence TEXT NOT NULL DEFAULT '{}'
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS consents_one_live_per_subject
     ON consents (kind, subject_hash) WHERE revoked_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS consents_by_person ON consents (person_id, kind)`,
  `CREATE TABLE IF NOT EXISTS phone_challenges (
     id TEXT PRIMARY KEY,
     phone_hash TEXT NOT NULL,
     phone_hint TEXT NOT NULL DEFAULT '',
     code_hash TEXT NOT NULL,
     salt TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     requested_from TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     consumed_at TEXT,
     person_id TEXT REFERENCES people(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS phone_challenges_live ON phone_challenges (phone_hash, expires_at)`,
  `CREATE TABLE IF NOT EXISTS social_proofs (
     id TEXT PRIMARY KEY,
     person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     network TEXT NOT NULL,
     handle TEXT NOT NULL,
     nonce TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     evidence_url TEXT,
     created_at TEXT NOT NULL,
     verified_at TEXT,
     expires_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS social_proofs_pending ON social_proofs (person_id, status)`,
  `CREATE TABLE IF NOT EXISTS signals (
     id TEXT PRIMARY KEY,
     person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     consent_id TEXT REFERENCES consents(id) ON DELETE CASCADE,
     source TEXT NOT NULL,
     kind TEXT NOT NULL,
     value TEXT NOT NULL,
     confidence REAL NOT NULL DEFAULT 1.0,
     observed_at TEXT NOT NULL,
     expires_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS signals_by_person ON signals (person_id, kind)`,
  `CREATE TABLE IF NOT EXISTS matches (
     id TEXT PRIMARY KEY,
     a_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     b_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     score REAL NOT NULL,
     score_breakdown TEXT NOT NULL,
     reasons TEXT NOT NULL,
     blockers TEXT NOT NULL DEFAULT '[]',
     engine_version TEXT NOT NULL,
     created_at TEXT NOT NULL,
     matched_at TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS matches_pair ON matches (a_id, b_id)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id TEXT PRIMARY KEY,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     subject_hash TEXT,
     at TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '{}'
   )`,
  `CREATE INDEX IF NOT EXISTS audit_by_time ON audit_log (at DESC)`,
  // Self-declared handles. A row here means "this person says this account is
  // theirs, and consented to us reading it under signal.enrich". A handle is not
  // a lookup key: nothing in this API resolves a handle to a person.
  `CREATE TABLE IF NOT EXISTS declared_handles (
     id           TEXT PRIMARY KEY,
     person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     network      TEXT NOT NULL,
     handle       TEXT NOT NULL,
     method       TEXT NOT NULL DEFAULT 'self_declared'
                  CHECK (method IN ('self_declared','proof_post','oauth')),
     verified     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
     consent_id   TEXT REFERENCES consents(id) ON DELETE CASCADE,
     evidence_url TEXT,
     created_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL,
     UNIQUE (person_id, network)
   )`,
  `CREATE INDEX IF NOT EXISTS declared_handles_consent ON declared_handles (consent_id)`,
  `CREATE INDEX IF NOT EXISTS declared_handles_person ON declared_handles (person_id, network)`,
  `CREATE TABLE IF NOT EXISTS intros (
     id TEXT PRIMARY KEY,
     a_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     b_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     thread_url TEXT NOT NULL,
     thread_host TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','declined')),
     proposed_by TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     proposed_at TEXT NOT NULL,
     responded_at TEXT,
     closed_at TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS intros_pair ON intros (a_id, b_id)`,
  `CREATE INDEX IF NOT EXISTS intros_status ON intros (status)`,
  // What survives an erase: a hash, a count, and when. No name, no location, no
  // interests. It exists so that erasing an account cannot reset the match cap or
  // retire a phone number into a fresh identity.
  `CREATE TABLE IF NOT EXISTS retired_identities (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     subject_hash TEXT NOT NULL,
     matches_at_retirement INTEGER NOT NULL DEFAULT 0,
     retired_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS retired_identities_lookup ON retired_identities (kind, subject_hash)`,

];

function columns(db: Db, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

/**
 * Additive migrations only. Each one is safe to run on every boot, which is the
 * only reason this can stay a list of statements instead of a migration runner.
 */
function migrate(db: Db): void {
  const matches = columns(db, "matches");
  if (!matches.has("matched_at")) {
    db.exec("ALTER TABLE matches ADD COLUMN matched_at TEXT");
    // The quota window starts at the introduction, not at the last time we
    // re-showed the pair, so backfill from the old column once.
    db.exec("UPDATE matches SET matched_at = created_at WHERE matched_at IS NULL");
  }
  const challenges = columns(db, "phone_challenges");
  if (!challenges.has("requested_from")) {
    db.exec("ALTER TABLE phone_challenges ADD COLUMN requested_from TEXT NOT NULL DEFAULT ''");
  }
  const intros = columns(db, "intros");
  if (!intros.has("closed_at")) {
    db.exec("ALTER TABLE intros ADD COLUMN closed_at TEXT");
  }
}

export function openDb(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  for (const statement of SCHEMA) db.exec(statement);
  migrate(db);
  return db;
}

export function audit(
  db: Db,
  actor: string,
  action: string,
  subjectHash: string | null,
  detail: Record<string, unknown> = {},
): void {
  db.prepare(
    `INSERT INTO audit_log (id, actor, action, subject_hash, at, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    actor,
    action,
    subjectHash,
    nowIso(),
    JSON.stringify(detail),
  );
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
