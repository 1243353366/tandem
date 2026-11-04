/**
 * HTTP surface.
 *
 * Route table lives in one place on purpose: it is the thing to read when
 * auditing what this service can do. Every mutating route takes a bearer token;
 * every route that touches an identifier goes through `policy.ts`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { audit } from "./db.ts";
import { hashToken, newId, newToken } from "./crypto.ts";
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  tooMany,
  unauthorized,
} from "./errors.ts";
import {
  REVERSE_LOOKUP_REFUSED,
  isForbiddenRoute,
  assertNoReverseLookup,
} from "./policy.ts";
import { validateProfile } from "./validate.ts";
import {
  allConsents,
  consentView,
  countPeople,
  createPerson,
  createProof,
  erasePerson,
  getPerson,
  getPersonByTokenHash,
  getProof,
  liveConsents,
  listSearchable,
  matcherPayload,
  personView,
  recordMatch,
  resolveProof,
  revokeConsent,
  updatePerson,
} from "./store.ts";
import type { PersonRow } from "./store.ts";
import { startPhoneConsent, verifyPhoneConsent } from "./consent.ts";
import { closeIntro, createIntro, introView, listIntrosFor, respondToIntro } from "./intros.ts";
import { matchQuota } from "./quota.ts";

/** How many people one browse shows. */
const MATCHES_PER_REQUEST = 2;
import {
  NETWORKS,
  exchangeOAuthCode,
  newOAuthState,
  oauthAuthorizeUrl,
  proofInstructions,
  verifyProofPost,
} from "./social.ts";
import type { FetchLike } from "./social.ts";
import {
  HANDLE_NETWORKS,
  applyMemberSignals,
  declareHandle,
  listHandles,
  observedInterests,
  removeHandle,
  serviceMembers,
} from "./handles.ts";
import { requestMatches } from "./matcher.ts";

const MAX_BODY_BYTES = 256 * 1024;

export type App = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

type Ctx = {
  db: Db;
  config: Config;
  fetcher: FetchLike;
};

// ------------------------------------------------------------------ http ----

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (overflowed) return; // drain, do not buffer
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) {
        reject(new ApiError(413, "payload_too_large", "Request body is too large."));
        return;
      }
      if (chunks.length === 0) return resolve({});
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(badRequest("Body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}

/**
 * Reflect only origins we were told about. The old version echoed any Origin
 * header, which let any page on the internet call this API from a visitor's
 * browser. Bearer tokens made that survivable, not correct.
 */
function allowedOrigins(): string[] {
  const configured = `${process.env.TANDEM_ALLOWED_ORIGINS ?? ""},${process.env.TANDEM_PUBLIC_URL ?? ""}`;
  return configured
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return new URL(entry).origin;
      } catch {
        return entry.replace(/\/+$/, "");
      }
    });
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  const allowed = allowedOrigins();
  const permit = origin && (allowed.length === 0 ? true : allowed.includes(origin)) ? origin : allowed[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": permit,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length >= 20 ? token : null;
}

function requirePerson(ctx: Ctx, req: IncomingMessage): PersonRow {
  const token = bearer(req);
  if (!token) throw unauthorized();
  const person = getPersonByTokenHash(ctx.db, hashToken(token));
  if (!person) throw unauthorized("That token is not valid.");
  return person;
}

// ---------------------------------------------------------------- routes ----

type ApiRequest = IncomingMessage & { body?: unknown };

type Handler = (
  ctx: Ctx,
  req: ApiRequest,
  res: ServerResponse,
  params: string[],
) => Promise<void> | void;

type Route = { method: string; pattern: RegExp; handler: Handler };

/**
 * Service-token guard for the two operator endpoints the scout uses.
 *
 * They answer "whose own accounts may I read on their behalf", never "who is this
 * handle". Without TANDEM_SERVICE_TOKEN they do not exist outside dev mode, so a
 * fork cannot accidentally publish a member directory.
 */
function requireService(ctx: Ctx, req: ApiRequest): void {
  const expected = process.env.TANDEM_SERVICE_TOKEN ?? "";
  if (!expected) {
    if (ctx.config.dev) return;
    throw notFound("Not found.");
  }
  if ((req.headers.authorization ?? "") !== `Bearer ${expected}`) {
    throw unauthorized("A service token is required for this endpoint.");
  }
}

function callerOf(req: IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() ?? "";
  return forwarded || req.socket.remoteAddress || "";
}

const ROUTES: Route[] = [
  // -- quota ---------------------------------------------------------------
  {
    method: "GET",
    pattern: /^\/v1\/quota$/,
    handler: (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      send(res, 200, matchQuota(ctx.db, person.id));
    },
  },

  // -- introductions: public thread, or nothing ----------------------------
  {
    method: "GET",
    pattern: /^\/v1\/intros$/,
    handler: (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      send(res, 200, {
        intros: listIntrosFor(ctx.db, person.id).map((row) => introView(row, person.id)),
        note: "An introduction is a public thread you both can see. There are no messages here.",
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/intros$/,
    handler: (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const peerId = String(body.peer_id ?? "").trim();
      if (!peerId) throw badRequest("peer_id is required.", [{ field: "peer_id", message: "required" }]);
      const row = createIntro(ctx.db, { proposerId: person.id, peerId, threadUrl: body.thread_url });
      send(res, 201, { intro: introView(row, person.id) });
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/intros\/respond$/,
    handler: (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const introId = String(body.intro_id ?? "").trim();
      if (!introId) throw badRequest("intro_id is required.", [{ field: "intro_id", message: "required" }]);
      const row = respondToIntro(ctx.db, { introId, personId: person.id, accept: body.accept === true });
      send(res, 200, {
        intro: introView(row, person.id),
        note:
          row.status === "accepted"
            ? "Both of you can see the thread now."
            : "Declined. The other side is not told, and nothing is opened up.",
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/intros\/close$/,
    handler: (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const introId = String(body.intro_id ?? "").trim();
      if (!introId) throw badRequest("intro_id is required.", [{ field: "intro_id", message: "required" }]);
      const row = closeIntro(ctx.db, { introId, personId: person.id });
      send(res, 200, {
        intro: introView(row, person.id),
        note: "Closed. Neither side can propose this introduction again for 30 days.",
      });
    },
  },

  // Direct messages are not a missing feature; they are a refusal.
  {
    method: "POST",
    pattern: /^(\/v1\/(dm|dms|messages)|\/v1\/intros\/[A-Za-z0-9_-]+\/message)$/,
    handler: (_ctx, _req, res) => {
      send(res, 403, {
        error: "refused",
        message:
          "Tandem has no direct messages. Introductions happen in a public thread the person " +
          "chose, so nothing here can be used to reach someone in private.",
        see: "POST /v1/intros with a public thread URL",
      });
    },
  },

  // -- operator: one digest ------------------------------------------------
  {
    method: "GET",
    pattern: /^\/v1\/service\/cohort$/,
    handler: (ctx, req, res) => {
      requireService(ctx, req);
      const one = (sql: string, ...args: Array<string | number>) =>
        Number((ctx.db.prepare(sql).get(...args) as { n?: number } | undefined)?.n ?? 0);
      const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
      send(res, 200, {
        generated_at: new Date().toISOString(),
        people: one("SELECT COUNT(*) AS n FROM people"),
        verified: one("SELECT COUNT(DISTINCT person_id) AS n FROM consents WHERE revoked_at IS NULL"),
        waiting_to_verify: one(
          "SELECT COUNT(*) AS n FROM people WHERE id NOT IN (SELECT person_id FROM consents WHERE revoked_at IS NULL)",
        ),
        matches_last_14d: one("SELECT COUNT(*) AS n FROM matches WHERE created_at >= ?", since),
        intros: {
          proposed: one("SELECT COUNT(*) AS n FROM intros WHERE status = 'proposed'"),
          accepted: one("SELECT COUNT(*) AS n FROM intros WHERE status = 'accepted'"),
          declined: one("SELECT COUNT(*) AS n FROM intros WHERE status = 'declined'"),
        },
        revoked_consents: one("SELECT COUNT(*) AS n FROM consents WHERE revoked_at IS NOT NULL"),
        signals: one("SELECT COUNT(*) AS n FROM signals"),
        declared_handles: one("SELECT COUNT(*) AS n FROM declared_handles"),
        cap_per_person: 2,
        cap_window_days: 14,
        the_number_that_matters:
          "intros.accepted, then whether those pairs are still talking in two weeks. " +
          "Nothing else here decides the cohort.",
      });
    },
  },

  {
    method: "GET",
    pattern: /^\/healthz$/,
    handler: (ctx, _req, res) => {
      send(res, 200, {
        ok: true,
        service: "tandem-api",
        policy_version: ctx.config.policyVersion,
        people: countPeople(ctx.db),
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/policy$/,
    handler: (ctx, _req, res) => {
      send(res, 200, {
        policy_version: ctx.config.policyVersion,
        receipt_scheme: "hmac-sha256 over canonical receipt body, recomputable from export",
        identifiers_at_rest: "one-way hash under a server pepper; no ciphertext copy exists",
        reverse_lookup: "not supported, by policy and by test",
        scopes: {
          "identity.verify": "confirms you control the identifier; enables matching",
          "match.signals": "allows traits derived from this source to influence ranking",
        },
        retention: {
          phone_codes: "deleted on use or after 10 minutes",
          consents: "until revoked, then inert immediately and purged on account erasure",
          audit_log: "action names and hashes only, never identifiers",
        },
        user_controls: [
          "GET /v1/consent lists every live consent with its receipt hash",
          "POST /v1/consent/:id/revoke deletes derived signals in the same transaction",
          "GET /v1/export returns everything we hold about you",
          "DELETE /v1/people/:id erases the profile and all consents",
        ],
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/stats$/,
    handler: (ctx, _req, res) => {
      const rows = ctx.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM people WHERE status = 'active') AS people,
             (SELECT COUNT(DISTINCT person_id) FROM consents WHERE revoked_at IS NULL) AS verified,
             (SELECT COUNT(*) FROM matches) AS matches`,
        )
        .get() as { people: number; verified: number; matches: number };
      send(res, 200, rows);
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/networks$/,
    handler: (_ctx, _req, res) => {
      send(res, 200, {
        networks: Object.entries(NETWORKS).map(([id, meta]) => ({ id, ...meta })),
      });
    },
  },

  // -- people -------------------------------------------------------------
  {
    method: "POST",
    pattern: /^\/v1\/people$/,
    handler: (ctx, req, res) => {
      const result = validateProfile(req.body, ctx.config);
      if (!result.ok) throw badRequest("Some fields need fixing.", result.errors);

      const { token, hash } = newToken();
      const person = createPerson(ctx.db, result.value, hash);

      send(
        res,
        201,
        {
          person: personView(person, []),
          token,
          note:
            "This token is shown once. Only its hash is stored, so we cannot recover it. " +
            "Send it as: Authorization: Bearer <token>",
          next_step:
            "POST /v1/consent/phone/start with {\"phone\": \"+15550100199\"} to verify, " +
            "then POST /v1/matches.",
        },
        corsHeaders(req),
      );
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/people\/([0-9a-fA-F-]{36})$/,
    handler: (ctx, req, res, params) => {
      const row = getPerson(ctx.db, params[0]);
      if (!row || row.status === "erased") throw notFound("No such person.");
      const consents = liveConsents(ctx.db, row.id);
      if (row.visibility !== "searchable") {
        const viewer = bearer(req);
        const owner = viewer ? getPersonByTokenHash(ctx.db, hashToken(viewer)) : null;
        if (!owner || owner.id !== row.id) throw notFound("No such person.");
      }
      send(res, 200, { person: personView(row, consents) });
    },
  },
  {
    method: "PATCH",
    pattern: /^\/v1\/people\/([0-9a-fA-F-]{36})$/,
    handler: (ctx, req, res, params) => {
      const person = requirePerson(ctx, req);
      if (person.id !== params[0]) throw forbidden("You can only edit your own profile.");
      const result = validateProfile(req.body, ctx.config, { partial: true });
      if (!result.ok) throw badRequest("Some fields need fixing.", result.errors);
      const updated = updatePerson(ctx.db, person.id, result.value);
      send(res, 200, { person: personView(updated!, liveConsents(ctx.db, person.id)) });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/people\/([0-9a-fA-F-]{36})$/,
    handler: (ctx, req, res, params) => {
      const person = requirePerson(ctx, req);
      if (person.id !== params[0]) throw forbidden("You can only erase your own profile.");
      erasePerson(ctx.db, person.id);
      send(res, 200, { erased: true, person_id: person.id });
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/me$/,
    handler: (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      const consents = allConsents(ctx.db, person.id);
      send(res, 200, {
        person: personView(person, liveConsents(ctx.db, person.id)),
        consents: consents.map(consentView),
        verified: liveConsents(ctx.db, person.id).length > 0,
      });
    },
  },

  // -- consent ------------------------------------------------------------
  {
    method: "POST",
    pattern: /^\/v1\/consent\/phone\/start$/,
    handler: async (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      const body = req.body as Record<string, unknown>;
      assertNoReverseLookup(body, true); // this IS the proof flow
      const result = await startPhoneConsent(ctx.db, ctx.config, person, body.phone, {
        requestedFrom: callerOf(req),
      });
      send(res, 200, result);
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/consent\/phone\/verify$/,
    handler: (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      const result = verifyPhoneConsent(ctx.db, ctx.config, person, req.body);
      send(res, 200, result);
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/consent$/,
    handler: (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      send(res, 200, { consents: allConsents(ctx.db, person.id).map(consentView) });
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/consent\/([0-9a-fA-F-]{36})\/revoke$/,
    handler: (ctx, req, res, params) => {
      const person = requirePerson(ctx, req);
      const ok = revokeConsent(ctx.db, person.id, params[0]);
      if (!ok) throw notFound("No such consent on your account.");
      send(res, 200, { revoked: true, consent_id: params[0] });
    },
  },

  // -- handles: accounts the person declares themselves -------------------
  {
    method: "GET",
    pattern: /^\/v1\/handles\/networks$/,
    handler: (_ctx, _req, res) => {
      send(res, 200, {
        networks: Object.entries(HANDLE_NETWORKS).map(([network, meta]) => ({
          network,
          label: meta.label,
          readable: meta.readable,
          reader: meta.reader,
          reason: meta.reason ?? null,
        })),
        note:
          "A handle is declared by its owner, never discovered. A readable network " +
          "contributes interest signals to that person's own matching.",
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/handles$/,
    handler: (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const view = declareHandle(
        ctx.db,
        ctx.config,
        person.id,
        String(body.network ?? ""),
        String(body.handle ?? ""),
      );
      send(res, 201, { handle: view });
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/me\/handles$/,
    handler: (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      send(res, 200, { handles: listHandles(ctx.db, person.id) });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/v1\/handles\/([A-Za-z0-9_:-]{3,140})$/,
    handler: (ctx, req, res, params) => {
      const person = requirePerson(ctx, req);
      removeHandle(ctx.db, person.id, params[0]);
      send(res, 200, { removed: true, handle_id: params[0] });
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/service\/members$/,
    handler: (ctx, req, res) => {
      requireService(ctx, req);
      send(res, 200, {
        members: serviceMembers(ctx.db),
        note:
          "Members whose own declared handles we may read under their consent. Not a " +
          "directory: every handle here was typed by the person it belongs to.",
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/service\/members\/([0-9a-fA-F-]{36})\/signals$/,
    handler: (ctx, req, res, params) => {
      requireService(ctx, req);
      const result = applyMemberSignals(ctx.db, params[0], (req.body ?? {}) as Record<string, unknown>);
      send(res, 200, { person_id: params[0], ...result });
    },
  },

  // -- social -------------------------------------------------------------
  {
    method: "POST",
    pattern: /^\/v1\/social\/([a-z]+)\/start$/,
    handler: (ctx, req, res, params) => {
      const person = requirePerson(ctx, req);
      const network = params[0];
      const meta = NETWORKS[network];
      if (!meta) throw notFound(`Unknown network: ${network}`);
      const body = (req.body ?? {}) as Record<string, unknown>;

      if (meta.method === "oauth") {
        const state = newOAuthState();
        createProof(ctx.db, {
          personId: person.id,
          network,
          handle: "pending-oauth",
          nonce: state,
          ttlSeconds: 900,
        });
        send(res, 200, {
          method: "oauth",
          network,
          authorize_url: oauthAuthorizeUrl(ctx.config, network, state),
          note:
            "You authorize with the platform itself. Tandem reads your own account only, " +
            "and only what that platform is still willing to expose.",
        });
        return;
      }

      const handle = String(body.handle ?? "");
      if (!handle) throw badRequest("handle is required for proof-post verification.");
      const proof = createProof(ctx.db, {
        personId: person.id,
        network,
        handle,
        nonce: newOAuthState(),
        ttlSeconds: ctx.config.social.proofTtlSeconds,
      });
      const row = getProof(ctx.db, proof.id)!;
      send(res, 200, {
        method: "proof_post",
        network,
        proof_id: proof.id,
        nonce: row.nonce,
        expires_at: proof.expiresAt,
        ...proofInstructions(network, handle, row.nonce),
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/social\/([a-z]+)\/verify$/,
    handler: async (ctx, req, res, params) => {
      const person = requirePerson(ctx, req);
      const network = params[0];
      const body = (req.body ?? {}) as Record<string, unknown>;
      const proofId = String(body.proof_id ?? "");
      const proof = getProof(ctx.db, proofId);
      if (!proof || proof.person_id !== person.id) throw notFound("No such verification attempt.");
      if (proof.network !== network) throw badRequest("That attempt belongs to another network.");
      if (proof.status === "verified") {
        send(res, 200, { status: "already_verified", evidence_url: proof.evidence_url });
        return;
      }
      if (new Date(proof.expires_at).getTime() < Date.now()) {
        resolveProof(ctx.db, proof.id, "expired", null);
        throw badRequest("That verification attempt expired. Start again.");
      }

      const result = await verifyProofPost(network, proof.handle, proof.nonce, ctx.fetcher);
      if (!result.ok) {
        resolveProof(ctx.db, proof.id, "failed", null);
        send(res, 200, { status: "not_yet", reason: result.reason });
        return;
      }

      resolveProof(ctx.db, proof.id, "verified", result.evidenceUrl);
      audit(ctx.db, person.id, "social.verified", null, { network });
      send(res, 200, { status: "verified", evidence_url: result.evidenceUrl, detail: result.detail });
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/social\/([a-z]+)\/callback$/,
    handler: async (ctx, req, res, params) => {
      const network = params[0];
      const url = new URL(req.url ?? "/", ctx.config.publicBaseUrl);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const denied = url.searchParams.get("error");
      if (denied) throw forbidden(`Authorization was declined (${denied}).`);
      if (!code || !state) throw badRequest("Missing code or state.");

      const proof = ctx.db
        .prepare("SELECT * FROM social_proofs WHERE nonce = ? AND network = ?")
        .get(state, network) as { id: string; person_id: string; status: string } | undefined;
      if (!proof) throw badRequest("That authorization link is not recognised. Start again.");
      if (proof.status === "verified") throw conflict("This account is already linked.");

      const identity = await exchangeOAuthCode(ctx.config, network, code, ctx.fetcher);
      ctx.db
        .prepare("UPDATE social_proofs SET handle = ?, status = 'verified', verified_at = ? WHERE id = ?")
        .run(identity.handle, new Date().toISOString(), proof.id);
      audit(ctx.db, proof.person_id, "social.linked", null, { network });

      res.writeHead(302, { Location: `${ctx.config.publicBaseUrl}/?linked=${network}`, "Cache-Control": "no-store" });
      res.end();
    },
  },

  // -- matching -----------------------------------------------------------
  {
    method: "POST",
    pattern: /^\/v1\/matches$/,
    handler: async (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      const mine = liveConsents(ctx.db, person.id);
      if (mine.length === 0) {
        throw forbidden(
          "Verify at least one identifier before requesting matches. " +
            "Matching is the one thing here that needs a real person on the other side of it.",
        );
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const quota = matchQuota(ctx.db, person.id);

      // The cap is on introductions, so being at it does not stop you looking. What
      // stops here is enumeration: ten new faces a day is enough to see who is
      // around, not enough to read the whole cohort.
      if (quota.reveals_remaining_today === 0) {
        throw tooMany(
          "You have looked at ten new people today, which is the daily limit. " +
            "It exists so nobody can read the whole cohort in an afternoon. Come back tomorrow.",
        );
      }

      // Two per request is the promise; ten a day is the ceiling. Both exist so that
      // one afternoon cannot read the whole cohort.
      const requested = Number.isFinite(Number(body.limit)) ? Number(body.limit) : MATCHES_PER_REQUEST;
      const limit = Math.max(1, Math.min(requested, MATCHES_PER_REQUEST, quota.reveals_remaining_today));

      const searchable = listSearchable(ctx.db).filter((row) => row.id !== person.id);
      // The cap is two a fortnight for a person, not two a fortnight from them.
      // Someone at their limit is not handed out again until their window moves.
      const withRoom = searchable.filter((row) => matchQuota(ctx.db, row.id).remaining > 0);
      const atCap = searchable.length - withRoom.length;

      const candidates = withRoom
        .map((row) => ({ row, consents: liveConsents(ctx.db, row.id) }))
        // Only identity-verified people are matchable. Unverified profiles can
        // exist and be edited; they just cannot be found.
        .filter((entry) => entry.consents.length > 0);

      const result = await requestMatches(
        ctx.config,
        matcherPayload(person, mine, observedInterests(ctx.db, person.id)),
        candidates.map((entry) =>
          matcherPayload(entry.row, entry.consents, observedInterests(ctx.db, entry.row.id)),
        ),
        limit,
        ctx.fetcher as typeof fetch,
      );

      const byId = new Map(candidates.map((entry) => [entry.row.id, entry]));
      const enriched = result.matches.slice(0, limit).map((match) => {
        const entry = byId.get(match.person_id);
        if (entry) {
          recordMatch(ctx.db, {
            aId: person.id,
            bId: match.person_id,
            score: match.score,
            breakdown: match.breakdown,
            reasons: match.reasons,
            blockers: match.blockers,
            engineVersion: result.engine_version,
          });
        }
        const view = entry ? personView(entry.row, entry.consents) : null;
        return {
          ...match,
          person: view
            ? {
                display_name: view.display_name,
                headline: view.headline,
                location: view.location,
                timezone: view.timezone,
                interests: view.interests,
                current_project: view.current_project,
                hours_per_week: view.hours_per_week,
                looking_for: view.looking_for,
                verified_channels: view.verified_channels,
              }
            : null,
        };
      });

      send(res, 200, {
        engine_version: result.engine_version,
        weights: result.weights,
        candidates_considered: candidates.length,
        matches: enriched,
      });
    },
  },

  // -- export -------------------------------------------------------------
  {
    method: "GET",
    pattern: /^\/v1\/export$/,
    handler: (ctx, req, res) => {
      const person = requirePerson(ctx, req);
      const proofs = ctx.db
        .prepare("SELECT network, handle, status, evidence_url, created_at, verified_at FROM social_proofs WHERE person_id = ?")
        .all(person.id);
      const matches = ctx.db
        .prepare(
          "SELECT a_id, b_id, score, engine_version, created_at, matched_at FROM matches WHERE a_id = ? OR b_id = ?",
        )
        .all(person.id, person.id);
      const handles = ctx.db
        .prepare(
          "SELECT network, handle, method, verified, evidence_url, created_at FROM declared_handles WHERE person_id = ?",
        )
        .all(person.id);
      // The inferred parts are the ones people actually want to see, so they are
      // in the export rather than only in the database.
      const signals = ctx.db
        .prepare(
          "SELECT source, kind, value, confidence, observed_at, expires_at FROM signals WHERE person_id = ?",
        )
        .all(person.id);
      const intros = ctx.db
        .prepare(
          `SELECT status, thread_url, thread_host, proposed_at, responded_at, closed_at,
                  CASE WHEN a_id = ? THEN b_id ELSE a_id END AS with_person
             FROM intros WHERE a_id = ? OR b_id = ?`,
        )
        .all(person.id, person.id, person.id);
      send(res, 200, {
        exported_at: new Date().toISOString(),
        policy_version: ctx.config.policyVersion,
        person: personView(person, liveConsents(ctx.db, person.id)),
        consents: allConsents(ctx.db, person.id).map(consentView),
        social_proofs: proofs,
        declared_handles: handles,
        signals,
        matches,
        intros,
        audit_retention:
          "Audit entries record the person id as the actor and survive an erase. " +
          "They contain no name, location, interest or message, and they are the one " +
          "thing that outlives a deletion on purpose.",
        note:
          "Identifier values are not recoverable: only hashes are stored. " +
          "Recompute any receipt_hash from the canonical receipt body to verify it.",
      });
    },
  },

  // -- the refusal --------------------------------------------------------
  {
    method: "POST",
    pattern: /^\/v1\/lookup$/,
    handler: (_ctx, _req, res) => {
      send(res, 403, REVERSE_LOOKUP_REFUSED);
    },
  },
];

/** Route table is exposed so tests can assert on it. */
export function routeTable(): Array<{ method: string; source: string }> {
  return ROUTES.map((route) => ({ method: route.method, source: route.pattern.source }));
}

export function createApp(db: Db, config: Config, fetcher: FetchLike = fetch): App {
  return {
    async handle(req, res) {
      const started = Date.now();
      // Every response carries an id, and every server-side error is logged with it,
      // so a report of "something broke" can be tied to one request.
      const requestId = newId().slice(0, 12);
      const headers = { ...corsHeaders(req), "X-Request-Id": requestId };
      // Set them on the response, not just on the calls that remember to pass them:
      // a route that sent its own body was answering without CORS or a request id,
      // so a browser allowed the preflight and then refused the response.
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "OPTIONS") {
        send(res, 204, undefined, headers);
        return;
      }

      // Belt and braces: even if a route were added by accident, its path is
      // refused before dispatch.
      if (isForbiddenRoute(path)) {
        send(res, 403, REVERSE_LOOKUP_REFUSED, headers);
        return;
      }

      const routed = ROUTES.filter((route) => route.method === req.method)
        .map((route) => ({ route, match: route.pattern.exec(path) }))
        .find((entry) => entry.match !== null);

      if (!routed) {
        send(res, 404, { error: "not_found", path, request_id: requestId }, headers);
        return;
      }

      try {
        if (req.method !== "GET" && req.method !== "DELETE") {
          (req as ApiRequest).body = await readBody(req);
        }
        await routed.route.handler(
          { db, config, fetcher },
          req as ApiRequest,
          res,
          (routed.match as RegExpExecArray).slice(1),
        );
      } catch (error) {
        if (res.headersSent) return;
        if (error instanceof ApiError) {
          send(res, error.status, { ...error.toJSON(), request_id: requestId }, headers);
          return;
        }
        const code = (error as Error & { code?: string }).code;
        if (code === "reverse_lookup") {
          send(
            res,
            403,
            { ...REVERSE_LOOKUP_REFUSED, detail: error instanceof Error ? error.message : null, request_id: requestId },
            headers,
          );
          return;
        }
        console.error(`[tandem] ${requestId} unhandled error on ${req.method} ${path}`, error);
        send(
          res,
          500,
          {
            error: "internal",
            message: "Something broke on our side.",
            request_id: requestId,
          },
          headers,
        );
      } finally {
        if (config.dev) {
          const line = `${requestId} ${req.method} ${path} -> ${res.statusCode} (${Date.now() - started}ms)`;
          if (res.statusCode >= 500) console.error(`[tandem] ${line}`);
        }
      }
    },
  };
}
