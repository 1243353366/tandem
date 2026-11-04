/**
 * Introductions happen in a public thread, or not at all.
 *
 * There is no message table in this schema and no route that sends one. The
 * product records that two matched people agreed to talk in a place that is
 * already public, and stops there. Anything that looked like a DM would become
 * the place where the consent model quietly stops applying.
 */

import type { Db } from "./db.ts";
import { badRequest, conflict, forbidden, notFound } from "./errors.ts";
import { newId } from "./crypto.ts";
import { liveConsents } from "./store.ts";
import { matchQuota } from "./quota.ts";

/** How long a "no" holds before the same pair can be proposed again. */
export const DECLINE_COOLDOWN_DAYS = 30;

/** Hosts where a thread is a closed space or a private message surface. */
const CLOSED_HOSTS = [
  "discord.com",
  "discord.gg",
  "snapchat.com",
  "t.me",
  "telegram.me",
  "whatsapp.com",
  "wa.me",
  "instagram.com",
  "facebook.com",
  "messenger.com",
  "linkedin.com",
  "signal.org",
  "slack.com",
];

const DM_PATH = /(^|\/)(dm|dms|messages|messaging|inbox|chat)(\/|$)/i;

export type Thread = { url: string; host: string };

/**
 * A thread is public when it is an https page on a host that is not a DM or a
 * closed space, with no credentials, no fragment and no tracking query.
 */
export function assertPublicThread(raw: unknown): Thread {
  const text = String(raw ?? "").trim();
  if (!text) throw badRequest("A thread URL is required.", [{ field: "thread_url", message: "required" }]);
  if (text.length > 500) throw badRequest("That URL is too long.");

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw badRequest("That is not a URL.", [{ field: "thread_url", message: "must be absolute" }]);
  }
  if (parsed.protocol !== "https:") {
    throw badRequest("The thread has to be a public https page.", [
      { field: "thread_url", message: "https only" },
    ]);
  }
  if (parsed.username || parsed.password) {
    throw forbidden("URLs with credentials in them are not public pages.");
  }
  const host = parsed.hostname.toLowerCase();
  if (CLOSED_HOSTS.some((closed) => host === closed || host.endsWith(`.${closed}`))) {
    throw forbidden(
      `${host} is a closed space or a message surface. An introduction goes in a public ` +
        "thread you chose, so both people can see it without either of them handing over a " +
        "contact detail.",
    );
  }
  if (DM_PATH.test(parsed.pathname)) {
    throw forbidden("That path looks like a private message surface, not a public thread.");
  }
  if (parsed.hash) parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref)/i.test(key)) parsed.searchParams.delete(key);
  }
  return { url: parsed.toString(), host };
}

export type IntroRow = {
  id: string;
  a_id: string;
  b_id: string;
  thread_url: string;
  thread_host: string;
  status: "proposed" | "accepted" | "declined";
  proposed_by: string;
  proposed_at: string;
  responded_at: string | null;
};

function pair(aId: string, bId: string): [string, string] {
  return aId < bId ? [aId, bId] : [bId, aId];
}

export function matchedPair(db: Db, aId: string, bId: string): boolean {
  const [a, b] = pair(aId, bId);
  const row = db.prepare("SELECT 1 AS ok FROM matches WHERE a_id = ? AND b_id = ?").get(a, b);
  return Boolean(row);
}

function personExists(db: Db, id: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS ok FROM people WHERE id = ?").get(id));
}

/**
 * A live consent is one that has not been revoked *and* has not expired. The
 * expiry half used to be missing here, which let an expired consent authorise an
 * introduction that store.liveConsents would elsewhere refuse.
 */
function hasLiveConsent(db: Db, id: string): boolean {
  return liveConsents(db, id).length > 0;
}

function cooldownUntil(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(new Date(iso).getTime() + DECLINE_COOLDOWN_DAYS * 86_400_000).toISOString();
}

export function createIntro(
  db: Db,
  values: { proposerId: string; peerId: string; threadUrl: unknown },
): IntroRow {
  if (values.proposerId === values.peerId) {
    throw badRequest("You cannot introduce yourself to yourself.");
  }
  if (!personExists(db, values.peerId)) throw notFound("No such person.");
  if (!hasLiveConsent(db, values.proposerId)) {
    throw forbidden("Verify an identifier before proposing an introduction.");
  }
  if (!hasLiveConsent(db, values.peerId)) {
    throw forbidden("That person has no live consent, so they cannot be introduced.");
  }
  if (!matchedPair(db, values.proposerId, values.peerId)) {
    throw forbidden(
      "Introductions are only for people you were actually matched with. " +
        "Request matches first, then pick one.",
    );
  }

  const thread = assertPublicThread(values.threadUrl);
  const [a, b] = pair(values.proposerId, values.peerId);
  const existing = db.prepare("SELECT * FROM intros WHERE a_id = ? AND b_id = ?").get(a, b) as
    | IntroRow
    | undefined;

  if (existing && !existing.closed_at) {
    if (existing.status === "accepted") {
      throw conflict("You two already have an introduction. Go and talk in the thread.");
    }
    if (existing.status === "proposed") {
      throw conflict("An introduction is already proposed for this pair.");
    }
  }

  // A "no" holds for a month, and so does a closed thread. Without this, a
  // decline was a button the proposer could simply press again.
  const cooledFrom = existing
    ? cooldownUntil(existing.closed_at ?? (existing.status === "declined" ? existing.responded_at : null))
    : null;
  if (cooledFrom && new Date(cooledFrom).getTime() > Date.now()) {
    throw forbidden(
      `That did not happen, recently. An introduction to this person can be proposed again after ` +
        `${cooledFrom.slice(0, 10)}. A no is supposed to mean something here.`,
    );
  }

  // The cap lives here, because an introduction is the unit that costs someone
  // else's attention. While it was enforced on /v1/matches it also limited intros
  // by accident; browsing is free now, so the cap has to be checked where the
  // introduction is actually made, on both sides of it.
  const proposerQuota = matchQuota(db, values.proposerId);
  if (proposerQuota.remaining === 0) {
    throw forbidden(
      `You have made ${proposerQuota.used} introductions in the last ${proposerQuota.window_days} days, ` +
        "which is the cap. Two a fortnight is deliberate: a list of ten people is not an introduction. " +
        `A slot frees up at ${proposerQuota.frees_up_at ?? "the end of the window"}.`,
    );
  }
  const peerQuota = matchQuota(db, values.peerId);
  if (peerQuota.remaining === 0) {
    throw forbidden(
      "That person is at their limit for introductions this fortnight. " +
        "They are not ignoring you; there is simply nothing to spend. Try again when their window moves.",
    );
  }

  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      `UPDATE intros SET thread_url = ?, thread_host = ?, status = 'proposed',
         proposed_by = ?, proposed_at = ?, responded_at = NULL, closed_at = NULL WHERE id = ?`,
    ).run(thread.url, thread.host, values.proposerId, now, existing.id);
    return db.prepare("SELECT * FROM intros WHERE id = ?").get(existing.id) as IntroRow;
  }

  const id = newId();
  db.prepare(
    `INSERT INTO intros (id, a_id, b_id, thread_url, thread_host, status, proposed_by, proposed_at, responded_at)
     VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, NULL)`,
  ).run(id, a, b, thread.url, thread.host, values.proposerId, now);
  return db.prepare("SELECT * FROM intros WHERE id = ?").get(id) as IntroRow;
}

export function listIntrosFor(db: Db, personId: string): IntroRow[] {
  return db
    .prepare("SELECT * FROM intros WHERE a_id = ? OR b_id = ? ORDER BY proposed_at DESC")
    .all(personId, personId) as IntroRow[];
}

export function getIntro(db: Db, introId: string): IntroRow {
  const row = db.prepare("SELECT * FROM intros WHERE id = ?").get(introId) as IntroRow | undefined;
  if (!row) throw notFound("No such introduction.");
  return row;
}

export function respondToIntro(
  db: Db,
  values: { introId: string; personId: string; accept: boolean },
): IntroRow {
  const row = getIntro(db, values.introId);
  if (row.a_id !== values.personId && row.b_id !== values.personId) {
    throw notFound("No such introduction.");
  }
  if (row.proposed_by === values.personId) {
    throw forbidden("The person who proposed an introduction cannot accept it.");
  }
  if (row.closed_at) {
    throw conflict("This introduction was closed. Propose a new one if you both still want it.");
  }
  if (row.status !== "proposed") {
    throw conflict(`This introduction is already ${row.status}.`);
  }
  db.prepare("UPDATE intros SET status = ?, responded_at = ? WHERE id = ?").run(
    values.accept ? "accepted" : "declined",
    new Date().toISOString(),
    row.id,
  );
  return getIntro(db, row.id);
}

/**
 * Either side can end an introduction, accepted or not. Withdrawing is closing;
 * there is no separate "unsend", because the other person may already have read it
 * and pretending otherwise would be a lie the API tells.
 */
export function closeIntro(db: Db, values: { introId: string; personId: string }): IntroRow {
  const row = getIntro(db, values.introId);
  if (row.a_id !== values.personId && row.b_id !== values.personId) {
    throw notFound("No such introduction.");
  }
  if (row.closed_at) return row;
  db.prepare("UPDATE intros SET closed_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  return getIntro(db, row.id);
}

/**
 * What each side sees. The proposer sees their own thread immediately; the peer
 * sees it only after accepting, so a declined introduction never hands over a
 * place to be found.
 */
export function introView(row: IntroRow, viewerId: string): Record<string, unknown> {
  const isProposer = row.proposed_by === viewerId;
  const visible = isProposer || row.status === "accepted";
  return {
    id: row.id,
    status: row.closed_at ? "closed" : row.status,
    closed_at: row.closed_at,
    proposed_by: isProposer ? "you" : "them",
    proposed_at: row.proposed_at,
    responded_at: row.responded_at,
    peer_id: row.a_id === viewerId ? row.b_id : row.a_id,
    thread_url: visible ? row.thread_url : null,
    thread_host: visible ? row.thread_host : null,
    note: visible
      ? "Both of you can see this thread. Reply there, in public, and nobody has to trade a phone number."
      : "They proposed a thread. Accept to see it.",
  };
}
