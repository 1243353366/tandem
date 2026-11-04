-- Tandem — schema v1
-- Target: Postgres 14+ (also runs on SQLite with the notes in docs/consent-model.md)
--
-- Design rule that shapes every table: a row about a person only exists because
-- that person created it. There is no table that maps an identifier we did not
-- receive by consent to a human profile. See db/README.md.

BEGIN;

-- ---------------------------------------------------------------- people ----
CREATE TABLE people (
    id              TEXT PRIMARY KEY,                -- uuid v4
    display_name    TEXT NOT NULL,
    headline        TEXT,                            -- one line, "what I'm building"
    location_city   TEXT,
    location_region TEXT,
    location_country TEXT,                           -- ISO 3166-1 alpha-2
    timezone        TEXT,                            -- IANA name, e.g. America/New_York
    interests       TEXT NOT NULL DEFAULT '[]',      -- json array of normalized tags
    current_project TEXT,
    project_tags    TEXT NOT NULL DEFAULT '[]',      -- json array
    hours_per_week  INTEGER NOT NULL DEFAULT 0
                    CHECK (hours_per_week >= 0 AND hours_per_week <= 80),
    looking_for     TEXT NOT NULL DEFAULT '[]',      -- json array, closed vocabulary
    offers          TEXT NOT NULL DEFAULT '[]',      -- json array, what they can give
    comm_style      TEXT NOT NULL DEFAULT '{}',      -- json object, see docs/matching.md
    visibility      TEXT NOT NULL DEFAULT 'searchable'
                    CHECK (visibility IN ('unlisted', 'searchable')),
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'erased')),
    api_token_hash  TEXT NOT NULL,                   -- sha256(pepper || token)
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX people_searchable ON people (visibility, status);

-- --------------------------------------------------------------- consents ----
-- Every identifier we are allowed to touch has exactly one of these rows,
-- written at the moment the person proved control of the identifier.
CREATE TABLE consents (
    id             TEXT PRIMARY KEY,
    person_id      TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL
                   CHECK (kind IN ('discord','facebook','github','bluesky','mastodon','hackernews','devto','telegram','gitlab','reddit','personal_site')),
    subject_hash   TEXT NOT NULL,        -- sha256(pepper || normalized identifier). Never the raw value.
    subject_hint   TEXT,                 -- e.g. "+1 ******0199" or "@handle", for the person's own UI
    scope          TEXT NOT NULL,        -- json array, e.g. ["verify_identity","match_signals"]
    policy_version TEXT NOT NULL,
    granted_at     TEXT NOT NULL,
    expires_at     TEXT,                 -- null = until revoked
    revoked_at     TEXT,                 -- non-null = inert, pending deletion
    receipt_hash   TEXT NOT NULL,        -- sha256 over the canonical receipt body
    evidence       TEXT NOT NULL DEFAULT '{}'  -- json: how control was proven
);

CREATE UNIQUE INDEX consents_one_live_per_subject
    ON consents (kind, subject_hash)
    WHERE revoked_at IS NULL;

CREATE INDEX consents_by_person ON consents (person_id, kind);

-- -------------------------------------------------- phone OTP challenges ----
CREATE TABLE phone_challenges (
    id           TEXT PRIMARY KEY,
    phone_hash   TEXT NOT NULL,
    code_hash    TEXT NOT NULL,          -- sha256(challenge_salt || code)
    salt         TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    consumed_at  TEXT,
    person_id    TEXT REFERENCES people(id) ON DELETE CASCADE
);

CREATE INDEX phone_challenges_live ON phone_challenges (phone_hash, expires_at);

-- ------------------------------------------------------- social proofs ----
-- Platforms without a usable OAuth path use a proof post: the person publishes
-- a nonce on their own account and we read it back. Their account, their post.
CREATE TABLE social_proofs (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    network     TEXT NOT NULL
                CHECK (network IN ('github','bluesky','mastodon','discord','facebook')),
    handle      TEXT NOT NULL,
    nonce       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','verified','failed','expired')),
    evidence_url TEXT,
    created_at  TEXT NOT NULL,
    verified_at TEXT,
    expires_at  TEXT NOT NULL
);

CREATE INDEX social_proofs_pending ON social_proofs (person_id, status);

-- ------------------------------------------------------ declared handles ----
-- A person's own accounts, declared by that person. Not a lookup table: there is
-- no query from a handle to a person, only from a person to a handle.
CREATE TABLE declared_handles (
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
);

CREATE INDEX declared_handles_consent ON declared_handles (consent_id);
CREATE INDEX declared_handles_person ON declared_handles (person_id, network);

-- -------------------------------------------------------------- signals ----
-- Derived attributes used by the matcher. Each row cites the consent that
-- justifies it; revoking that consent deletes these rows in the same transaction.
CREATE TABLE signals (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    consent_id  TEXT REFERENCES consents(id) ON DELETE CASCADE,
    source      TEXT NOT NULL,          -- 'self_reported' | 'github' | 'bluesky' | ...
    kind        TEXT NOT NULL,          -- 'interest' | 'language' | 'cadence' | 'topic'
    value       TEXT NOT NULL,
    confidence  REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    observed_at TEXT NOT NULL,
    expires_at  TEXT
);

CREATE INDEX signals_by_person ON signals (person_id, kind);

-- -------------------------------------------------------------- matches ----
CREATE TABLE matches (
    id               TEXT PRIMARY KEY,
    a_id             TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    b_id             TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    score            REAL NOT NULL CHECK (score >= 0 AND score <= 1),
    score_breakdown  TEXT NOT NULL,     -- json, per-factor contributions
    reasons          TEXT NOT NULL,     -- json array of plain-language strings
    blockers         TEXT NOT NULL DEFAULT '[]',
    engine_version   TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    CHECK (a_id < b_id)                 -- one canonical row per unordered pair
);

CREATE UNIQUE INDEX matches_pair ON matches (a_id, b_id);
CREATE INDEX matches_by_a ON matches (a_id, score DESC);

-- ------------------------------------------------------------ audit log ----
-- Append-only. Contains no raw identifiers, only hashes.
CREATE TABLE audit_log (
    id          TEXT PRIMARY KEY,
    actor       TEXT NOT NULL,          -- person id, or 'system'
    action      TEXT NOT NULL,          -- 'consent.granted', 'consent.revoked', 'person.erased', ...
    subject_hash TEXT,
    at          TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_by_time ON audit_log (at DESC);

COMMIT;
