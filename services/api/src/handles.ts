/**
 * Self-declared handles.
 *
 * The discovery question and the consent question are not the same question, and
 * conflating them is how a matching product turns into a people-search engine.
 *
 *   Who is this about?   Someone who typed their own handle on their own profile.
 *   What may we do?      Exactly the scopes on the consent that text created.
 *
 * So a handle here is not a lookup key. It is a claim of ownership, made by the
 * owner, that we may read their public output to improve *their* matches. The
 * consent row is created in the same transaction and cites the handle hash, and
 * revoking it deletes every signal derived from that handle.
 *
 * Which means: no endpoint in this file accepts a handle and returns a person.
 * There is no "who is @x on GitHub". There is only "this person says @x is
 * theirs", and the read that follows happens under their own scope.
 *
 * The word "scraping" deserves the same care. Adding a handle does not change
 * what a platform allows, and this file does not claim otherwise. Every reader in
 * `services/scout/tandem_scout/members.py` uses the platform's documented API,
 * one page deep, with a real User-Agent. What the declared handle changes is who
 * the reading is *about*: the person who asked for it.
 */

import { audit, transaction } from "./db.ts";
import type { Db } from "./db.ts";
import type { Config } from "./config.ts";
import { digest, handleHint } from "./crypto.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { insertConsent, liveConsents, revokeConsent } from "./store.ts";

export type HandleView = {
  id: string;
  network: string;
  handle: string;
  method: "self_declared" | "proof_post" | "oauth";
  verified: boolean;
  readable: boolean;
  why_not_readable: string | null;
  consent_id: string | null;
  evidence_url: string | null;
  created_at: string;
};

export type NetworkMeta = {
  label: string;
  pattern: RegExp;
  lower: boolean;
  readable: boolean;
  reader: string | null;
  /** Why a declared handle cannot be read. Said out loud rather than left blank. */
  reason?: string;
};

export const HANDLE_NETWORKS: Record<string, NetworkMeta> = {
  github: { label: "GitHub", pattern: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, lower: false, readable: true, reader: "repos" },
  hackernews: { label: "Hacker News", pattern: /^[A-Za-z0-9_-]{2,15}$/, lower: false, readable: true, reader: "comments" },
  devto: { label: "DEV Community", pattern: /^[A-Za-z0-9_]{2,30}$/, lower: true, readable: true, reader: "articles" },
  bluesky: { label: "Bluesky", pattern: /^[A-Za-z0-9.-]{3,253}$/, lower: true, readable: true, reader: "posts" },
  mastodon: { label: "Mastodon", pattern: /^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{3,253}$/, lower: true, readable: true, reader: "statuses" },
  reddit: { label: "Reddit", pattern: /^[A-Za-z0-9_-]{3,20}$/, lower: false, readable: true, reader: "submitted" },
  gitlab: { label: "GitLab", pattern: /^[A-Za-z0-9._-]{2,255}$/, lower: false, readable: true, reader: "projects" },
  codeberg: { label: "Codeberg", pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{1,38}$/, lower: false, readable: true, reader: "repos" },
  stackoverflow: { label: "Stack Overflow (numeric user id)", pattern: /^[0-9]{1,12}$/, lower: false, readable: true, reader: "answers" },
  personal_site: { label: "Personal site", pattern: /^[A-Za-z0-9.-]{3,253}$/, lower: true, readable: true, reader: "feed" },
  // Declared, but not readable. Kept in the table so a person can still put the
  // account on their profile and be matched on it; the API says why it is dark.
  snapchat: {
    label: "Snapchat",
    pattern: /^[A-Za-z0-9._-]{3,30}$/,
    lower: true,
    readable: false,
    reader: null,
    reason:
      "Snapchat publishes no API for profile or group content, and its groups are " +
      "join-gated rather than public. Reading one would mean reading a closed space, " +
      "so a declared Snapchat handle is shown and matched on, never read.",
  },
  instagram: {
    label: "Instagram",
    pattern: /^[A-Za-z0-9._]{1,30}$/,
    lower: true,
    readable: false,
    reader: null,
    reason: "Instagram serves profile content only to an authenticated session. Declared, not read.",
  },
  facebook: {
    label: "Facebook",
    pattern: /^[A-Za-z0-9.]{5,50}$/,
    lower: true,
    readable: false,
    reader: null,
    reason:
      "Facebook gates profile and group content behind login, and groups are closed or " +
      "invite-only. Declared, not read.",
  },
  threads: {
    label: "Threads",
    pattern: /^[A-Za-z0-9._]{1,30}$/,
    lower: true,
    readable: false,
    reader: null,
    reason: "Threads requires an authenticated app token per reader. Declared, not read.",
  },
  linkedin: {
    label: "LinkedIn",
    pattern: /^[A-Za-z0-9-]{3,100}$/,
    lower: true,
    readable: false,
    reader: null,
    reason:
      "LinkedIn forbids third-party reading of profile content without a partner " +
      "agreement. Declared, not read.",
  },
  telegram: {
    label: "Telegram",
    pattern: /^[A-Za-z0-9_]{4,64}$/,
    lower: false,
    readable: false,
    reader: null,
    reason:
      "Telegram has no API for reading a person's messages; channels are readable as a " +
      "publisher page, which is a different thing from a personal handle. Declared, not read.",
  },
  discord: {
    label: "Discord",
    pattern: /^[A-Za-z0-9._]{2,32}$/,
    lower: true,
    readable: false,
    reader: null,
    reason:
      "Discord content lives in servers you must join, and joining is not public " +
      "availability. Declared, not read.",
  },
  youtube: {
    label: "YouTube",
    pattern: /^[A-Za-z0-9._-]{3,30}$/,
    lower: true,
    readable: false,
    reader: null,
    reason: "YouTube reading needs a project API key per deployment. Declared, not read.",
  },
};

/** Scopes a declared handle can carry. Deliberately short. */
export const HANDLE_SCOPES = ["signal.enrich"] as const;

export function normalizeHandle(network: string, raw: unknown): string {
  const meta = HANDLE_NETWORKS[network];
  if (!meta) {
    throw badRequest(
      `"${network}" is not a network Tandem accepts handles for.`,
      [{ field: "network", message: `choose one of: ${Object.keys(HANDLE_NETWORKS).join(", ")}` }],
    );
  }
  const text = String(raw ?? "").trim().replace(/^@+/, "");
  if (!text) throw badRequest("A handle is required.", [{ field: "handle", message: "required" }]);
  if (text.length > 255) throw badRequest("That handle is too long.", [{ field: "handle", message: "max 255" }]);
  if (!meta.pattern.test(text)) {
    throw badRequest(
      `That does not look like a ${meta.label} handle.`,
      [{ field: "handle", message: "letters, digits, and . _ - only" }],
    );
  }
  return meta.lower ? text.toLowerCase() : text;
}

function handleHash(config: Config, network: string, handle: string): string {
  return digest(config.pepper, `handle:${network}:${handle}`);
}

export function handleView(row: Record<string, unknown>): HandleView {
  const network = String(row.network);
  const meta = HANDLE_NETWORKS[network];
  return {
    id: String(row.id),
    network,
    handle: String(row.handle),
    method: String(row.method) as HandleView["method"],
    verified: Boolean(row.verified),
    readable: Boolean(meta?.readable),
    why_not_readable: meta?.reason ?? null,
    consent_id: row.consent_id ? String(row.consent_id) : null,
    evidence_url: row.evidence_url ? String(row.evidence_url) : null,
    created_at: String(row.created_at),
  };
}

/**
 * Attach a handle to a profile and record the consent that permits reading it.
 *
 * One live consent per (network, handle hash) across the whole instance: two
 * accounts cannot both claim the same GitHub account, and the conflict is
 * reported without revealing whose it is.
 */
export function declareHandle(
  db: Db,
  config: Config,
  personId: string,
  network: string,
  rawHandle: string,
): HandleView {
  const handle = normalizeHandle(network, rawHandle);
  const subjectHash = handleHash(config, network, handle);
  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT * FROM declared_handles WHERE person_id = ? AND network = ?")
    .get(personId, network) as Record<string, unknown> | undefined;

  if (existing && String(existing.handle) === handle) {
    return handleView(existing);
  }

  const claimed = db
    .prepare(
      `SELECT person_id FROM consents
        WHERE kind = ? AND subject_hash = ? AND revoked_at IS NULL`,
    )
    .get(network, subjectHash) as { person_id: string } | undefined;
  if (claimed && claimed.person_id !== personId) {
    throw conflict(
      "That handle is already linked to another account. If it is yours, remove it there first.",
    );
  }

  // Retire the old claim first: revokeConsent is itself transactional, and it
  // takes the derived signals with it.
  if (existing?.consent_id) revokeConsent(db, personId, String(existing.consent_id));

  return transaction(db, () => {
    if (existing) {
      db.prepare("DELETE FROM declared_handles WHERE id = ?").run(String(existing.id));
    }

    const consent = insertConsent(db, {
      personId,
      kind: network,
      subjectHash,
      subjectHint: handleHint(handle),
      scope: [...HANDLE_SCOPES],
      policyVersion: config.policyVersion,
      expiresAt: null,
      receiptHash: digest(config.pepper, `receipt:handle:${network}:${subjectHash}:${config.policyVersion}`),
      evidence: { method: "self_declared", network },
    });

    const id = `hnd_${subjectHash.slice(0, 20)}_${network}`;
    db.prepare(
      `INSERT INTO declared_handles
         (id, person_id, network, handle, method, verified, consent_id, evidence_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'self_declared', 0, ?, NULL, ?, ?)`,
    ).run(id, personId, network, handle, consent.id, now, now);

    audit(db, personId, "handle.declared", subjectHash, { network });
    const row = db.prepare("SELECT * FROM declared_handles WHERE id = ?").get(id) as Record<string, unknown>;
    return handleView(row);
  });
}

export function listHandles(db: Db, personId: string): HandleView[] {
  const rows = db
    .prepare("SELECT * FROM declared_handles WHERE person_id = ? ORDER BY created_at")
    .all(personId) as Record<string, unknown>[];
  return rows.map(handleView);
}

export function removeHandle(db: Db, personId: string, handleId: string): boolean {
  const row = db
    .prepare("SELECT * FROM declared_handles WHERE id = ? AND person_id = ?")
    .get(handleId, personId) as Record<string, unknown> | undefined;
  if (!row) throw notFound("No such handle on your profile.");

  if (row.consent_id) revokeConsent(db, personId, String(row.consent_id));

  return transaction(db, () => {
    db.prepare("DELETE FROM declared_handles WHERE id = ?").run(handleId);
  });
  audit(db, personId, "handle.removed", null, { network: row.network });
  return true;
}

/**
 * Mark a handle as proof-verified. Called by the proof-post flow so a verified
 * link does not end up in the profile twice under two methods.
 */
export function markHandleVerified(
  db: Db,
  personId: string,
  network: string,
  handle: string,
  evidenceUrl: string,
): void {
  db.prepare(
    `UPDATE declared_handles
        SET method = 'proof_post', verified = 1, evidence_url = ?, updated_at = ?
      WHERE person_id = ? AND network = ? AND handle = ?`,
  ).run(evidenceUrl, new Date().toISOString(), personId, network, handle);
}

// ------------------------------------------------------------- service API ----

/**
 * Members who opted into handle enrichment, for the scout to read.
 *
 * This is an operator-side endpoint: it answers "whose own accounts may I read
 * on their behalf", never "who is this handle". It requires the service token and
 * refuses to exist without one.
 */
export function serviceMembers(db: Db): Array<{
  person_id: string;
  handles: Array<{ network: string; handle: string; verified: boolean }>;
}> {
  const rows = db
    .prepare(
      `SELECT h.person_id, h.network, h.handle, h.verified, h.consent_id, c.revoked_at, c.scope
         FROM declared_handles h
         JOIN consents c ON c.id = h.consent_id
        WHERE c.revoked_at IS NULL
        ORDER BY h.person_id, h.network`,
    )
    .all() as Array<Record<string, unknown>>;

  const byPerson = new Map<string, Array<{ network: string; handle: string; verified: boolean }>>();
  for (const row of rows) {
    if (!scopesOf(row).includes("signal.enrich")) continue;
    const meta = HANDLE_NETWORKS[String(row.network)];
    if (!meta?.readable) continue;
    const list = byPerson.get(String(row.person_id)) ?? [];
    list.push({
      network: String(row.network),
      handle: String(row.handle),
      verified: Boolean(row.verified),
    });
    byPerson.set(String(row.person_id), list);
  }

  return [...byPerson.entries()].map(([person_id, handles]) => ({ person_id, handles }));
}

/**
 * Store signals a member's own accounts produced.
 *
 * Signals cite the consent that justified them, so revocation deletes them. Only
 * turns tags into `interest` rows; nothing here can add a person, a handle, or a
 * contact detail.
 */
export function applyMemberSignals(
  db: Db,
  personId: string,
  body: Record<string, unknown>,
): { stored: number; interests: string[] } {
  const live = liveConsents(db, personId).filter(
    (consent) =>
      HANDLE_NETWORKS[consent.kind] !== undefined &&
      scopesOf(consent as unknown as Record<string, unknown>).includes("signal.enrich"),
  );
  if (!live.length) {
    throw conflict("That member has no live handle consent, so there is nothing to derive.");
  }

  const rawInterests = Array.isArray(body.interests) ? body.interests : [];
  const interests = rawInterests
    .map((tag) => String(tag).trim().toLowerCase())
    .filter((tag) => /^[a-z0-9+#.-]{2,32}$/.test(tag))
    .slice(0, 12);
  const observations = Number(body.observations ?? 0);
  const sources = Array.isArray(body.sources) ? body.sources.map(String) : [];
  // An observation belongs to the network it came from. Without this, a Mastodon
  // read was written under the GitHub consent and deleting one did not remove the
  // other's signals.
  const network = body.network ? String(body.network).trim().toLowerCase() : null;
  const scoped = network ? live.filter((consent) => consent.kind === network) : live;
  if (!scoped.length) {
    throw conflict(`That member has no live handle consent for ${network}, so there is nothing to derive.`);
  }

  return transaction(db, () => {
    db.prepare("DELETE FROM signals WHERE person_id = ? AND kind = 'interest' AND source LIKE 'handle:%'")
      .run(personId);
    const insert = db.prepare(
      `INSERT INTO signals (id, person_id, consent_id, source, kind, value, confidence, observed_at, expires_at)
       VALUES (?, ?, ?, ?, 'interest', ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    // Signals go stale. Ninety days is long enough to be useful and short enough
    // that a quiet account stops steering matches.
    const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
    let stored = 0;
    for (const consent of scoped) {
      for (const interest of interests) {
        insert.run(
          `sig_${personId.slice(0, 8)}_${consent.kind}_${interest}_${stored}`,
          personId,
          consent.id,
          `handle:${consent.kind}`,
          interest,
          Math.min(1, 0.5 + observations / 60),
          now,
          expiresAt,
        );
        stored += 1;
      }
    }
    audit(db, personId, "signals.derived", null, { networks: sources, tags: interests.length });
    return { stored, interests };
  });
}

function scopesOf(row: Record<string, unknown>): string[] {
  const raw = row.scope;
  if (Array.isArray(raw)) return raw as string[];
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function observedInterests(db: Db, personId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT value FROM signals
        WHERE person_id = ? AND kind = 'interest' AND source LIKE 'handle:%'
          AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(personId, new Date().toISOString()) as Array<{ value: string }>;
  return rows.map((row) => row.value);
}
