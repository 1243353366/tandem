/**
 * Regressions from the code review.
 *
 * Each test here failed against the review build. They are grouped by the promise
 * that was broken rather than by module: erase, the cap, the export, the decline.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { observedInterests } from "../src/handles.ts";
import { createChallenge } from "../src/store.ts";

type Harness = {
  base: string;
  db: Db;
  api: (method: string, path: string, options?: { token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; json: any }>;
};

let harness: Harness;

const PROFILE = {
  display_name: "Reviewer",
  headline: "testing the promises",
  location_city: "Brooklyn",
  location_region: "NY",
  location_country: "US",
  interests: ["ai", "security"],
  current_project: "a review",
  project_tags: ["python"],
  hours_per_week: 4,
  looking_for: ["cofounder"],
  offers: ["cofounder"],
  timezone: "America/New_York",
  comm_style: { pace: "async", directness: 3, group_size: "small", prefers: ["text"] },
};

function fakeMatcher(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const matches = (body.candidates ?? []).map((candidate: any, index: number) => ({
    person_id: candidate.id,
    display_name: candidate.display_name,
    score: Math.max(0.4, 0.9 - index * 0.1),
    breakdown: {},
    reasons: ["shared ai"],
    blockers: [],
  }));
  return Promise.resolve(
    new Response(JSON.stringify({ engine_version: "review", person_id: body.subject?.id, weights: {}, matches }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

before(async () => {
  process.env.TANDEM_ALLOWED_ORIGINS = "https://app.tandem.test";
  const config = loadConfig({
    port: 0,
    host: "127.0.0.1",
    dbPath: ":memory:",
    dev: true,
    pepper: "review-pepper-please-ignore",
    matcherUrl: "http://127.0.0.1:1",
    publicBaseUrl: "http://127.0.0.1:1",
  });
  const db = openDb(":memory:");
  const app = createApp(db, config, fakeMatcher as unknown as typeof fetch);
  const server: Server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const api: Harness["api"] = async (method, path, options = {}) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };

  harness = { base, db, api };
  (harness as unknown as { server: Server }).server = server;
});

after(async () => {
  const server = (harness as unknown as { server: Server }).server;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  harness.db.close();
});

const TOKENS: Record<string, string> = {};

async function intake(name: string, overrides: Record<string, unknown> = {}) {
  const created = await harness.api("POST", "/v1/people", { body: { ...PROFILE, display_name: name, ...overrides } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const person = { id: created.json.person.id as string, token: created.json.token as string };
  TOKENS[person.id] = person.token;
  return person;
}

async function verifyPhone(token: string, phone: string) {
  const start = await harness.api("POST", "/v1/consent/phone/start", { token, body: { phone } });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const done = await harness.api("POST", "/v1/consent/phone/verify", {
    token,
    body: { challenge_id: start.json.challenge_id, code: start.json.dev_code },
  });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  return done.json.consent_id as string;
}

// ---------------------------------------------------------------------------

describe("erase actually erases", () => {
  it("blanks every descriptive column, not just the name", async () => {
    const person = await intake("Erasable", { location_city: "Brooklyn", interests: ["ai", "rust"] });
    await verifyPhone(person.token, "+15550200001");
    const erased = await harness.api("DELETE", `/v1/people/${person.id}`, { token: person.token });
    assert.equal(erased.status, 200);

    const row = harness.db.prepare("SELECT * FROM people WHERE id = ?").get(person.id) as Record<string, any>;
    assert.equal(row.status, "erased");
    assert.equal(row.display_name, "[erased]");
    for (const column of ["headline", "location_city", "location_region", "location_country", "timezone", "current_project"]) {
      assert.equal(row[column], "", `${column} must be empty after erase`);
    }
    for (const column of ["interests", "project_tags", "looking_for", "offers"]) {
      assert.equal(row[column], "[]", `${column} must be empty after erase`);
    }
    assert.equal(row.comm_style, "{}");
    assert.equal(row.hours_per_week, 0);
    assert.equal(row.visibility, "hidden");
  });

  it("keeps a hash and a match count so erase cannot reset the cap", async () => {
    const peer = await intake("PeerForCarry");
    await verifyPhone(peer.token, "+15550200002");
    const other = await intake("OtherForCarry");
    await verifyPhone(other.token, "+15550200003");

    const person = await intake("CapCheater");
    await verifyPhone(person.token, "+15550200004");
    const matched = await harness.api("POST", "/v1/matches", { token: person.token, body: { limit: 10 } });
    assert.equal(matched.status, 200);
    assert.equal(matched.json.matches.length, 2);

    const before = await harness.api("GET", "/v1/quota", { token: person.token });
    assert.equal(before.json.remaining, 0);

    await harness.api("DELETE", `/v1/people/${person.id}`, { token: person.token });

    // Same person, same phone, fresh account.
    const again = await intake("CapCheater");
    await verifyPhone(again.token, "+15550200004");
    const quota = await harness.api("GET", "/v1/quota", { token: again.token });
    assert.equal(quota.status, 200);
    assert.equal(quota.json.carried_over, 2, "the cap follows the phone, not the profile row");
    assert.equal(quota.json.remaining, 0);

    const refused = await harness.api("POST", "/v1/matches", { token: again.token, body: { limit: 5 } });
    assert.equal(refused.status, 403);
  });
});

describe("the export is the whole record", () => {
  it("includes declared handles, derived signals and introductions", async () => {
    const me = await intake("Exporter");
    await verifyPhone(me.token, "+15550200010");
    const peer = await intake("ExportedPeer");
    await verifyPhone(peer.token, "+15550200011");

    const handle = await harness.api("POST", "/v1/handles", {
      token: me.token,
      body: { network: "github", handle: "exporter-review" },
    });
    assert.equal(handle.status, 201);
    const signals = await harness.api("POST", `/v1/service/members/${me.id}/signals`, {
      body: { interests: ["ai"], observations: 3, sources: ["github"], network: "github" },
    });
    assert.equal(signals.status, 200);

    const matched = await harness.api("POST", "/v1/matches", { token: me.token, body: { limit: 1 } });
    assert.equal(matched.status, 200);
    await harness.api("POST", "/v1/intros", {
      token: me.token,
      body: { peer_id: matched.json.matches[0].person_id, thread_url: "https://github.com/o/r/issues/9" },
    });

    const exported = await harness.api("GET", "/v1/export", { token: me.token });
    assert.equal(exported.status, 200);
    assert.equal(exported.json.declared_handles.length, 1);
    assert.ok(exported.json.signals.length >= 1, "what we inferred is included");
    assert.equal(exported.json.intros.length, 1);
    assert.ok(exported.json.audit_retention, "the one thing erase keeps is written down");
  });

  it("a signal is scoped to the network it came from", async () => {
    const me = await intake("Scoped");
    await verifyPhone(me.token, "+15550200012");
    await harness.api("POST", "/v1/handles", { token: me.token, body: { network: "github", handle: "scoped-review" } });
    const wrong = await harness.api("POST", `/v1/service/members/${me.id}/signals`, {
      body: { interests: ["ai"], network: "mastodon" },
    });
    assert.equal(wrong.status, 409, "a mastodon read cannot be written under a github consent");
  });

  it("expired signals stop steering matches", async () => {
    const me = await intake("Stale");
    const past = new Date(Date.now() - 86_400_000).toISOString();
    harness.db
      .prepare(
        `INSERT INTO signals (id, person_id, consent_id, source, kind, value, confidence, observed_at, expires_at)
         VALUES ('stale-1', ?, NULL, 'handle:github', 'interest', 'stale-tag', 1, ?, ?)`,
      )
      .run(me.id, past, past);
    harness.db
      .prepare(
        `INSERT INTO signals (id, person_id, consent_id, source, kind, value, confidence, observed_at, expires_at)
         VALUES ('fresh-1', ?, NULL, 'handle:github', 'interest', 'fresh-tag', 1, ?, NULL)`,
      )
      .run(me.id, new Date().toISOString());
    const interests = observedInterests(harness.db, me.id);
    assert.equal(interests.includes("stale-tag"), false);
    assert.equal(interests.includes("fresh-tag"), true);
  });
});

describe("the cap is two a fortnight, both ways", () => {
  it("does not hand out someone who is already at their limit", async () => {
    const busy = await intake("Busy");
    await verifyPhone(busy.token, "+15550200020");
    // Busy spends their own quota on two matches, so they are at their ceiling.
    const spent = await harness.api("POST", "/v1/matches", { token: busy.token, body: { limit: 2 } });
    assert.equal(spent.status, 200);
    const busyQuota = await harness.api("GET", "/v1/quota", { token: busy.token });
    assert.equal(busyQuota.json.remaining, 0);

    const newcomer = await intake("Newcomer");
    await verifyPhone(newcomer.token, "+15550200021");
    const offered = await harness.api("POST", "/v1/matches", { token: newcomer.token, body: { limit: 10 } });
    assert.equal(offered.status, 200);
    const ids = offered.json.matches.map((match: any) => match.person_id);
    assert.equal(ids.includes(busy.id), false, "someone at their cap is not offered again");
  });

  it("does not restart the window when the same pair is shown twice", async () => {
    const a = await intake("WindowA");
    await verifyPhone(a.token, "+15550200022");
    const b = await intake("WindowB");
    await verifyPhone(b.token, "+15550200023");
    void b;

    await harness.api("POST", "/v1/matches", { token: a.token, body: { limit: 1 } });
    const first = harness.db
      .prepare("SELECT matched_at FROM matches WHERE a_id = ? OR b_id = ?")
      .get(a.id, a.id) as { matched_at: string };
    await new Promise((resolve) => setTimeout(resolve, 12));
    await harness.api("POST", "/v1/matches", { token: a.token, body: { limit: 1 } });
    const second = harness.db
      .prepare("SELECT matched_at FROM matches WHERE a_id = ? OR b_id = ?")
      .get(a.id, a.id) as { matched_at: string };
    assert.equal(second.matched_at, first.matched_at, "matched_at is an introduction time, not a last-seen time");
  });
});

describe("a no means something", () => {
  it("refuses to re-propose inside the cooldown, and closing ends it", async () => {
    const a = await intake("Proposer");
    await verifyPhone(a.token, "+15550200030");
    const b = await intake("Decliner");
    await verifyPhone(b.token, "+15550200031");

    void b;
    const matched = await harness.api("POST", "/v1/matches", { token: a.token, body: { limit: 1 } });
    const peerId = matched.json.matches[0].person_id;
    const peerToken = TOKENS[peerId];
    assert.ok(peerToken, "the matched peer is a person we created");

    const proposed = await harness.api("POST", "/v1/intros", {
      token: a.token,
      body: { peer_id: peerId, thread_url: "https://github.com/o/r/issues/11" },
    });
    assert.equal(proposed.status, 201);
    const introId = proposed.json.intro.id;

    const declined = await harness.api("POST", "/v1/intros/respond", {
      token: peerToken,
      body: { intro_id: introId, accept: false },
    });
    assert.equal(declined.status, 200);

    const retry = await harness.api("POST", "/v1/intros", {
      token: a.token,
      body: { peer_id: peerId, thread_url: "https://github.com/o/r/issues/12" },
    });
    assert.equal(retry.status, 403, "a decline holds for a month");
    assert.match(retry.json.message, /after \d{4}-\d{2}-\d{2}/);
  });

  it("lets either side close an accepted introduction", async () => {
    const a = await intake("Closer");
    await verifyPhone(a.token, "+15550200032");
    const b = await intake("Closed");
    await verifyPhone(b.token, "+15550200033");
    void b;

    const matched = await harness.api("POST", "/v1/matches", { token: a.token, body: { limit: 1 } });
    const peerId = matched.json.matches[0].person_id;
    const peerToken = TOKENS[peerId];
    const proposed = await harness.api("POST", "/v1/intros", {
      token: a.token,
      body: { peer_id: peerId, thread_url: "https://github.com/o/r/issues/13" },
    });
    const introId = proposed.json.intro.id;
    await harness.api("POST", "/v1/intros/respond", {
      token: peerToken,
      body: { intro_id: introId, accept: true },
    });

    const closed = await harness.api("POST", "/v1/intros/close", { token: a.token, body: { intro_id: introId } });
    assert.equal(closed.status, 200);
    assert.equal(closed.json.intro.status, "closed");

    const again = await harness.api("POST", "/v1/intros", {
      token: a.token,
      body: { peer_id: peerId, thread_url: "https://github.com/o/r/issues/14" },
    });
    assert.equal(again.status, 403);
  });
});

describe("the doors that were too wide", () => {
  it("does not echo an origin it was not told about", async () => {
    // The preflight is the path that actually answers with CORS headers.
    const blocked = await fetch(`${harness.base}/v1/policy`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(blocked.status, 204);
    assert.notEqual(blocked.headers.get("access-control-allow-origin"), "https://evil.example");
    assert.equal(blocked.headers.get("access-control-allow-origin"), "https://app.tandem.test");

    const allowed = await fetch(`${harness.base}/v1/policy`, {
      method: "OPTIONS",
      headers: { Origin: "https://app.tandem.test" },
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://app.tandem.test");
  });

  it("rate limits verification codes per caller, not only per phone", async () => {
    const person = await intake("SmsAbuser");
    const origin = "203.0.113.9";
    for (let index = 0; index < 25; index += 1) {
      createChallenge(harness.db, {
        phoneHash: `hash-${index}`,
        phoneHint: "",
        codeHash: "c",
        salt: "s",
        ttlSeconds: 300,
        personId: person.id,
        requestedFrom: origin,
      });
    }
    const response = await harness.api("POST", "/v1/consent/phone/start", {
      token: person.token,
      body: { phone: "+15550200040" },
      headers: { "x-forwarded-for": origin },
    });
    assert.equal(response.status, 429);
  });
});
