/**
 * API tests. Real HTTP against a real server on an ephemeral port and an
 * in-memory database, with two things faked: SMS delivery and the matcher.
 *
 * The most important test in this file is `receipt hash is recomputable`:
 * a consent receipt that only the server can verify is not a receipt.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { createApp, routeTable } from "../src/app.ts";
import { isForbiddenRoute } from "../src/policy.ts";
import { canonicalize, receiptHash } from "../src/consent.ts";

type Harness = {
  base: string;
  db: Db;
  server: Server;
  api: (method: string, path: string, options?: { token?: string; body?: unknown }) => Promise<{
    status: number;
    json: any;
  }>;
};

let harness: Harness;

/** A stand-in for the Python matcher: ranks candidates in the order given. */
function fetcherWithFakeMatcher(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = String(url);
  if (target.endsWith("/match")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const matches = (body.candidates ?? []).map((candidate: any, index: number) => ({
      person_id: candidate.id,
      display_name: candidate.display_name,
      score: Math.max(0.3, 0.95 - index * 0.1),
      breakdown: {},
      reasons: ["fake matcher"],
      blockers: [],
    }));
    return Promise.resolve(
      new Response(JSON.stringify({ engine_version: "test", person_id: body.subject?.id, weights: {}, matches }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }
  throw new Error(`unexpected fetch to ${target}`);
}

async function startHarness(): Promise<Harness> {
  const config = loadConfig({
    port: 0,
    host: "127.0.0.1",
    dbPath: ":memory:",
    dev: true,
    pepper: "test-pepper-please-ignore",
    matcherUrl: "http://127.0.0.1:1",
    publicBaseUrl: "http://127.0.0.1:1",
  });
  const db = openDb(":memory:");
  const app = createApp(db, config, fetcherWithFakeMatcher as unknown as typeof fetch);
  const server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const base = `http://127.0.0.1:${port}`;
  const api = async (method: string, path: string, options: { token?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
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

  return { base, db, server, api };
}

const PROFILE = {
  display_name: "Ada",
  headline: "building a local-first evidence tool",
  interests: ["ai", "security", "python"],
  current_project: "local-first evidence tool",
  project_tags: ["python", "security"],
  hours_per_week: 6,
  looking_for: ["cofounder"],
  offers: ["cofounder"],
  timezone: "America/New_York",
  comm_style: { pace: "async", directness: 3, group_size: "small", prefers: ["text"] },
};

async function signup(overrides: Record<string, unknown> = {}): Promise<{ id: string; token: string }> {
  const response = await harness.api("POST", "/v1/people", { body: { ...PROFILE, ...overrides } });
  assert.equal(response.status, 201, JSON.stringify(response.json));
  return { id: response.json.person.id, token: response.json.token };
}

async function verifyPhone(token: string, phone: string): Promise<{ consentId: string; receipt: any }> {
  const start = await harness.api("POST", "/v1/consent/phone/start", { token, body: { phone } });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const verify = await harness.api("POST", "/v1/consent/phone/verify", {
    token,
    body: { challenge_id: start.json.challenge_id, code: start.json.dev_code },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  return { consentId: verify.json.consent_id, receipt: verify.json.receipt };
}

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  harness.db.close();
});

// ---------------------------------------------------------------------------

describe("profiles", () => {
  it("creates a person and returns a token exactly once", async () => {
    const created = await signup();
    assert.match(created.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(created.id.length, 36);

    const fetched = await harness.api("GET", `/v1/people/${created.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.person.display_name, "Ada");
    assert.equal(fetched.json.person.verified, false);
    assert.equal(fetched.json.token, undefined);
    assert.equal(fetched.json.person.api_token_hash, undefined);
  });

  it("never stores the raw token", async () => {
    const created = await signup();
    const rows = harness.db.prepare("SELECT api_token_hash FROM people").all() as Array<{ api_token_hash: string }>;
    assert.ok(rows.every((row) => row.api_token_hash !== created.token));
  });

  it("requires a goal, because a profile with no goal can never match", async () => {
    const response = await harness.api("POST", "/v1/people", { body: { ...PROFILE, looking_for: [] } });
    assert.equal(response.status, 400);
    assert.ok(response.json.detail.some((e: any) => e.field === "looking_for"));
  });

  it("refuses contact details in public fields", async () => {
    for (const headline of [
      "text me at 555-010-0199 any time",
      "reach me at ada@example.com",
      "find me @ada_builds",
    ]) {
      const response = await harness.api("POST", "/v1/people", { body: { ...PROFILE, headline } });
      assert.equal(response.status, 400, headline);
      assert.match(response.json.detail[0].message, /contact details|remove/);
    }
  });

  it("accepts a bare @ inside a normal sentence but not a handle", async () => {
    const ok = await harness.api("POST", "/v1/people", { body: { ...PROFILE, headline: "works @ home on tooling" } });
    assert.equal(ok.status, 201);
  });

  it("rejects roles outside the vocabulary", async () => {
    const response = await harness.api("POST", "/v1/people", { body: { ...PROFILE, looking_for: ["pen pal"] } });
    assert.equal(response.status, 400);
  });

  it("rejects nonsense timezones", async () => {
    const response = await harness.api("POST", "/v1/people", { body: { ...PROFILE, timezone: "Mars/Olympus" } });
    assert.equal(response.status, 400);
  });

  it("hides unlisted profiles from strangers but not from the owner", async () => {
    const owner = await signup({ display_name: "Shy", visibility: "unlisted" });
    const stranger = await signup({ display_name: "Nosy" });

    const asStranger = await harness.api("GET", `/v1/people/${owner.id}`, { token: stranger.token });
    assert.equal(asStranger.status, 404);

    const asOwner = await harness.api("GET", `/v1/people/${owner.id}`, { token: owner.token });
    assert.equal(asOwner.status, 200);
  });

  it("only lets the owner edit their own profile", async () => {
    const a = await signup();
    const b = await signup({ display_name: "Other" });
    const response = await harness.api("PATCH", `/v1/people/${b.id}`, { token: a.token, body: { headline: "hijacked" } });
    assert.equal(response.status, 403);
  });

  it("erases on request", async () => {
    const person = await signup({ display_name: "Temporary" });
    await verifyPhone(person.token, "+15550100077");
    const erase = await harness.api("DELETE", `/v1/people/${person.id}`, { token: person.token });
    assert.equal(erase.status, 200);

    const after = await harness.api("GET", `/v1/people/${person.id}`, { token: person.token });
    assert.equal(after.status, 404);

    const consents = harness.db
      .prepare("SELECT COUNT(*) AS n FROM consents WHERE person_id = ?")
      .get(person.id) as { n: number };
    assert.equal(consents.n, 0, "consents must not survive erasure");
  });
});

describe("phone consent", () => {
  it("issues a code, rejects the wrong one, and accepts the right one", async () => {
    const person = await signup();
    const start = await harness.api("POST", "/v1/consent/phone/start", {
      token: person.token,
      body: { phone: "+1 (555) 010-0111" },
    });
    assert.equal(start.status, 200);
    assert.equal(start.json.hint, "+1\u2022\u2022\u2022\u2022\u2022\u20220111");
    assert.match(start.json.dev_code, /^\d{6}$/);

    const wrong = await harness.api("POST", "/v1/consent/phone/verify", {
      token: person.token,
      body: { challenge_id: start.json.challenge_id, code: "000000" === start.json.dev_code ? "111111" : "000000" },
    });
    assert.equal(wrong.status, 400);

    const right = await harness.api("POST", "/v1/consent/phone/verify", {
      token: person.token,
      body: { challenge_id: start.json.challenge_id, code: start.json.dev_code },
    });
    assert.equal(right.status, 200);
    assert.equal(right.json.status, "verified");
    assert.deepEqual(right.json.receipt.scope, ["identity.verify", "match.signals"]);
  });

  it("makes the receipt hash recomputable by anyone holding the receipt", async () => {
    const person = await signup();
    const { receipt } = await verifyPhone(person.token, "+15550100222");
    const { receipt_hash: claimed, ...body } = receipt;
    assert.equal(receiptHash(body), claimed);
    assert.equal(canonicalize(body).includes(" "), false);
  });

  it("never stores the phone number", async () => {
    const person = await signup();
    await verifyPhone(person.token, "+15550100333");
    const dump = JSON.stringify(harness.db.prepare("SELECT * FROM consents").all());
    assert.equal(dump.includes("5550100333"), false, "raw phone leaked into consents");
    const challenges = JSON.stringify(harness.db.prepare("SELECT * FROM phone_challenges").all());
    assert.equal(challenges.includes("5550100333"), false, "raw phone leaked into challenges");
  });

  it("burns a code after use", async () => {
    const person = await signup();
    const start = await harness.api("POST", "/v1/consent/phone/start", {
      token: person.token,
      body: { phone: "+15550100444" },
    });
    const first = await harness.api("POST", "/v1/consent/phone/verify", {
      token: person.token,
      body: { challenge_id: start.json.challenge_id, code: start.json.dev_code },
    });
    assert.equal(first.status, 200);

    const replay = await harness.api("POST", "/v1/consent/phone/verify", {
      token: person.token,
      body: { challenge_id: start.json.challenge_id, code: start.json.dev_code },
    });
    assert.equal(replay.status, 409);
  });

  it("rate limits code requests", async () => {
    const person = await signup();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const response = await harness.api("POST", "/v1/consent/phone/start", {
        token: person.token,
        body: { phone: `+1555011000${i}` },
      });
      statuses.push(response.status);
    }
    assert.ok(statuses.includes(429), `expected a 429, got ${statuses.join(",")}`);
  });

  it("stops a second account from claiming the same number", async () => {
    const first = await signup({ display_name: "First" });
    const second = await signup({ display_name: "Second" });
    await verifyPhone(first.token, "+15550100555");

    const start = await harness.api("POST", "/v1/consent/phone/start", {
      token: second.token,
      body: { phone: "+15550100555" },
    });
    // The flow looks identical until the phone is proven, so no number oracle.
    assert.equal(start.status, 200);
    const verify = await harness.api("POST", "/v1/consent/phone/verify", {
      token: second.token,
      body: { challenge_id: start.json.challenge_id, code: start.json.dev_code },
    });
    assert.equal(verify.status, 409);
  });

  it("does not reveal anything before the phone is proven", async () => {
    const first = await signup({ display_name: "Holder" });
    await verifyPhone(first.token, "+15550100666");
    const probe = await signup({ display_name: "Prober" });
    const start = await harness.api("POST", "/v1/consent/phone/start", {
      token: probe.token,
      body: { phone: "+15550100666" },
    });
    assert.equal(start.json.status, "code_sent");
    assert.equal(JSON.stringify(start.json).toLowerCase().includes("already"), false);
  });

  it("rejects malformed numbers", async () => {
    const person = await signup();
    for (const phone of ["123", "not a number", "+++", "", "1234567890123456789"]) {
      const response = await harness.api("POST", "/v1/consent/phone/start", {
        token: person.token,
        body: { phone },
      });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(phone)}`);
    }
  });

  it("revokes immediately and reports status", async () => {
    const person = await signup();
    const { consentId } = await verifyPhone(person.token, "+15550100777");

    const listed = await harness.api("GET", "/v1/consent", { token: person.token });
    assert.equal(listed.json.consents.length, 1);
    assert.equal(listed.json.consents[0].status, "active");

    const revoked = await harness.api("POST", `/v1/consent/${consentId}/revoke`, { token: person.token });
    assert.equal(revoked.status, 200);

    const relisted = await harness.api("GET", "/v1/consent", { token: person.token });
    assert.equal(relisted.json.consents[0].status, "revoked");

    // and matching is blocked again
    const matches = await harness.api("POST", "/v1/matches", { token: person.token, body: {} });
    assert.equal(matches.status, 403);
  });

  it("cannot revoke someone else's consent", async () => {
    const owner = await signup();
    const attacker = await signup({ display_name: "Attacker" });
    const { consentId } = await verifyPhone(owner.token, "+15550100888");
    const response = await harness.api("POST", `/v1/consent/${consentId}/revoke`, { token: attacker.token });
    assert.equal(response.status, 404);
  });

  it("requires a token", async () => {
    const response = await harness.api("POST", "/v1/consent/phone/start", { body: { phone: "+15550100999" } });
    assert.equal(response.status, 401);
  });
});

describe("matching", () => {
  it("refuses to match unverified people", async () => {
    const person = await signup({ display_name: "Unverified" });
    const response = await harness.api("POST", "/v1/matches", { token: person.token, body: {} });
    assert.equal(response.status, 403);
  });

  it("returns verified candidates with reasons and never yourself", async () => {
    const me = await signup({ display_name: "Me" });
    const peer = await signup({ display_name: "Peer" });
    const lurking = await signup({ display_name: "Lurking" }); // unverified
    await verifyPhone(me.token, "+15550101001");
    await verifyPhone(peer.token, "+15550101002");

    const response = await harness.api("POST", "/v1/matches", { token: me.token, body: { limit: 10 } });
    assert.equal(response.status, 200);
    const names = response.json.matches.map((match: any) => match.person.display_name);
    assert.ok(names.includes("Peer"), `expected Peer in ${names.join(",")}`);
    assert.equal(names.includes("Me"), false);
    assert.equal(names.includes("Lurking"), false, "unverified profiles must not be matchable");
    assert.ok(response.json.matches[0].reasons.length > 0);
    assert.ok(response.json.candidates_considered > 0);
    void lurking;
  });

  it("persists computed matches for later inspection", async () => {
    const before = (harness.db.prepare("SELECT COUNT(*) AS n FROM matches").get() as { n: number }).n;
    const me = await signup({ display_name: "Persistent" });
    const peer = await signup({ display_name: "PersistentPeer" });
    await verifyPhone(me.token, "+15550101101");
    await verifyPhone(peer.token, "+15550101102");
    await harness.api("POST", "/v1/matches", { token: me.token, body: {} });
    const after = (harness.db.prepare("SELECT COUNT(*) AS n FROM matches").get() as { n: number }).n;
    assert.ok(after > before);
  });

  it("reports a clear error when the matcher is down", async () => {
    const config = loadConfig({
      dbPath: ":memory:",
      dev: true,
      pepper: "p",
      matcherUrl: "http://127.0.0.1:9",
    });
    const db = openDb(":memory:");
    const app = createApp(db, config, fetch);
    const server = createServer((req, res) => void app.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const created = await fetch(`http://127.0.0.1:${port}/v1/people`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PROFILE),
    }).then((r) => r.json());

    await fetch(`http://127.0.0.1:${port}/v1/consent/phone/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ phone: "+15550101201" }),
    }).then((r) => r.json());

    const start = await fetch(`http://127.0.0.1:${port}/v1/consent/phone/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ phone: "+15550101202" }),
    }).then((r) => r.json());

    await fetch(`http://127.0.0.1:${port}/v1/consent/phone/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ challenge_id: start.challenge_id, code: start.dev_code }),
    });

    const response = await fetch(`http://127.0.0.1:${port}/v1/matches`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${created.token}` },
      body: "{}",
    });
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.match(payload.message, /matching engine/i);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
});

describe("the refusal", () => {
  it("answers /v1/lookup with an explanation, not data", async () => {
    const response = await harness.api("POST", "/v1/lookup", { body: { phone: "+15550100001" } });
    assert.equal(response.status, 403);
    assert.equal(response.json.error, "reverse_lookup_not_supported");
  });

  it("flags every identifier-resolution path before dispatch", () => {
    const blocked = [
      "/v1/lookup",
      "/v1/search",
      "/v1/find",
      "/v1/resolve",
      "/v1/people/by-phone",
      "/v1/people/by-email",
      "/v1/people/by-handle",
      "/v1/people/by-subject",
    ];
    for (const path of blocked) assert.equal(isForbiddenRoute(path), true, path);

    const allowed = ["/v1/people", "/v1/matches", "/v1/consent", "/v1/people/1d2f7bcf-c3c6-4cd6-b31b-ddc2224b7bfc"];
    for (const path of allowed) assert.equal(isForbiddenRoute(path), false, path);
  });

  it("exposes exactly one lookup-shaped route: the documented refusal", () => {
    const lookupRoutes = routeTable().filter((route) => /lookup/.test(route.source));
    assert.equal(lookupRoutes.length, 1);
    assert.equal(lookupRoutes[0].method, "POST");
  });

  it("never puts a raw identifier in the export", async () => {
    const person = await signup({ display_name: "Exporter" });
    await verifyPhone(person.token, "+15550102020");
    const exported = await harness.api("GET", "/v1/export", { token: person.token });
    const dump = JSON.stringify(exported.json);
    assert.equal(dump.includes("5550102020"), false);
    assert.equal(dump.includes("@"), false, "export should carry no handles either");
    assert.equal(exported.json.consents[0].subject_hint.includes("\u2022"), true);
  });
});

describe("privacy surface", () => {
  it("publishes what it does with data", async () => {
    const response = await harness.api("GET", "/v1/policy");
    assert.equal(response.status, 200);
    assert.equal(response.json.reverse_lookup, "not supported, by policy and by test");
    assert.ok(response.json.scopes["identity.verify"]);
  });

  it("counts people without exposing them", async () => {
    const response = await harness.api("GET", "/v1/stats");
    assert.equal(response.status, 200);
    assert.equal(typeof response.json.people, "number");
    assert.equal(response.json.rows, undefined);
  });

  it("rejects oversized bodies", async () => {
    const person = await signup();
    const huge = "a".repeat(300 * 1024);
    const response = await harness.api("PATCH", `/v1/people/${person.id}`, {
      token: person.token,
      body: { headline: huge },
    });
    assert.ok([400, 413].includes(response.status), `got ${response.status}`);
  });
});
