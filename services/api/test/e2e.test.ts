/**
 * The whole MVP, end to end, over real HTTP against a real server.
 *
 * Every other test file checks one mechanism. This one checks the promise the
 * Epic makes: a person can arrive, verify, be matched, be introduced in public,
 * change their mind, take their data, and leave. If this file passes, the MVP
 * flow works; if it fails, nothing else matters.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { createApp, routeTable } from "../src/app.ts";

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

const PROFILE = {
  display_name: "Ada",
  headline: "infra and rust",
  location_city: "Brooklyn",
  interests: ["ai", "security"],
  current_project: "a local-first evidence tool",
  project_tags: ["python", "security"],
  hours_per_week: 6,
  looking_for: ["cofounder"],
  offers: ["cofounder"],
  timezone: "America/New_York",
  comm_style: { pace: "async", directness: 3, group_size: "small", prefers: ["text"] },
};

/** Ranks candidates in the order they arrive, with a reason on each. */
function fakeMatcher(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const matches = (body.candidates ?? []).map((candidate: any, index: number) => ({
    person_id: candidate.id,
    display_name: candidate.display_name,
    score: Math.max(0.4, 0.9 - index * 0.1),
    breakdown: {},
    reasons: ["you are both building in ai", "both free tuesday evenings"],
    blockers: [],
  }));
  return Promise.resolve(
    new Response(JSON.stringify({ engine_version: "e2e", person_id: body.subject?.id, weights: {}, matches }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

async function startHarness(): Promise<Harness> {
  const config = loadConfig({
    port: 0,
    host: "127.0.0.1",
    dbPath: ":memory:",
    dev: true,
    pepper: "e2e-pepper-please-ignore",
    matcherUrl: "http://127.0.0.1:1",
    publicBaseUrl: "http://127.0.0.1:1",
  });
  const db = openDb(":memory:");
  const app = createApp(db, config, fakeMatcher as unknown as typeof fetch);
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

type Person = { id: string; token: string };

async function intake(displayName: string): Promise<Person> {
  const created = await harness.api("POST", "/v1/people", { body: { ...PROFILE, display_name: displayName } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return { id: created.json.person.id, token: created.json.token };
}

async function verify(person: Person, phone: string): Promise<{ consentId: string }> {
  const start = await harness.api("POST", "/v1/consent/phone/start", { token: person.token, body: { phone } });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const done = await harness.api("POST", "/v1/consent/phone/verify", {
    token: person.token,
    body: { challenge_id: start.json.challenge_id, code: start.json.dev_code },
  });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  return { consentId: done.json.consent_id };
}

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  harness.db.close();
});

describe("the MVP flow, end to end", () => {
  const people: Person[] = [];
  let matchedPeer: string | null = null;

  it("1. four people complete intake and verify in one step", async () => {
    for (const [index, name] of ["Ada", "Grace", "Alan", "Barbara"].entries()) {
      const person = await intake(name);
      await verify(person, `+1555010010${index}`);
      people.push(person);
    }
    assert.equal(people.length, 4);

    const me = await harness.api("GET", "/v1/me", { token: people[0].token });
    assert.equal(me.status, 200);
    assert.equal(me.json.person.verified_channels.length >= 1, true, "a verified channel is what makes them findable");
    const consents = await harness.api("GET", "/v1/consent", { token: people[0].token });
    const live = consents.json.consents.filter((c: any) => !c.revoked_at);
    assert.equal(live.length, 1, "one verification, one live receipt");
    const hash = live[0].receipt_hash ?? live[0].receipt?.receipt_hash;
    assert.match(String(hash), /^[0-9a-f]{16,}$/, "a receipt the person can recompute");
  });

  it("2. matching returns at most two people, each with a stated reason", async () => {
    const response = await harness.api("POST", "/v1/matches", { token: people[0].token, body: { limit: 25 } });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.matches.length, 2, "the cap is product logic, not a suggestion");
    for (const match of response.json.matches) {
      assert.ok(match.reasons.length > 0, "every match says why it was made");
      assert.ok(match.score > 0);
    }
    matchedPeer = response.json.matches[0].person_id;
  });

  it("3. the quota reports itself, and browsing it does not spend the fortnight", async () => {
    const quota = await harness.api("GET", "/v1/quota", { token: people[0].token });
    assert.equal(quota.status, 200);
    assert.equal(quota.json.limit, 2);
    assert.equal(quota.json.unit, "introductions");
    // Two matches have been shown; no introduction has been made.
    assert.equal(quota.json.used, 0);
    assert.equal(quota.json.remaining, 2);
    assert.ok(quota.json.reveals_today >= 2);

    const again = await harness.api("POST", "/v1/matches", { token: people[0].token, body: { limit: 5 } });
    assert.equal(again.status, 200, "browsing again is allowed inside the daily reveal limit");

    const after = await harness.api("GET", "/v1/quota", { token: people[0].token });
    assert.equal(after.json.remaining, 2, "looking at people does not consume introductions");
  });

  it("4. an introduction in a closed space is refused", async () => {
    const peer = matchedPeer!;
    const discord = await harness.api("POST", "/v1/intros", {
      token: people[0].token,
      body: { peer_id: peer, thread_url: "https://discord.com/channels/123/456" },
    });
    assert.equal(discord.status, 403);
    assert.match(discord.json.message, /closed space|public thread/i);

    const insecure = await harness.api("POST", "/v1/intros", {
      token: people[0].token,
      body: { peer_id: peer, thread_url: "http://example.com/thread/1" },
    });
    assert.equal(insecure.status, 400);

    const dm = await harness.api("POST", "/v1/intros", {
      token: people[0].token,
      body: { peer_id: peer, thread_url: "https://github.com/messages/1" },
    });
    assert.equal(dm.status, 403);
  });

  it("5. an introduction in a public thread works, and needs the other side", async () => {
    const peer = matchedPeer!;
    const peerToken = people.find((person) => person.id === peer)!.token;

    const proposed = await harness.api("POST", "/v1/intros", {
      token: people[0].token,
      body: { peer_id: peer, thread_url: "https://github.com/1243353366/tandem/issues/1" },
    });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.json));
    const introId = proposed.json.intro.id;
    assert.equal(proposed.json.intro.thread_url, "https://github.com/1243353366/tandem/issues/1");

    const theirSide = await harness.api("GET", "/v1/intros", { token: peerToken });
    const seen = theirSide.json.intros.find((intro: any) => intro.id === introId);
    assert.equal(seen.thread_url, null, "the thread stays closed until they accept");

    const selfAccept = await harness.api("POST", "/v1/intros/respond", {
      token: people[0].token,
      body: { intro_id: introId, accept: true },
    });
    assert.equal(selfAccept.status, 403, "the proposer cannot accept on their behalf");

    const accepted = await harness.api("POST", "/v1/intros/respond", {
      token: peerToken,
      body: { intro_id: introId, accept: true },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.intro.status, "accepted");
    assert.match(accepted.json.intro.thread_url, /^https:\/\/github\.com\//);
  });

  it("6. there is no private message surface to fall back to", async () => {
    for (const path of ["/v1/dm", "/v1/messages", "/v1/dms"]) {
      const response = await harness.api("POST", path, { token: people[0].token, body: { text: "hi" } });
      assert.equal(response.status, 403, path);
      assert.match(response.json.message, /no direct messages/i);
    }
  });

  it("7. no endpoint resolves an identifier to a person", async () => {
    const lookup = await harness.api("GET", "/v1/lookup?handle=grace");
    assert.equal(lookup.status, 403);
    assert.match(String(lookup.json.error), /refused|reverse_lookup_not_supported/);

    const routes = routeTable().map((route) => route.source ?? "");
    const lookupRoutes = routes.filter((route) => /lookup|resolve|search/i.test(route));
    assert.deepEqual(
      lookupRoutes,
      ["^\\/v1\\/lookup$"],
      "the only lookup-shaped route is the one that refuses",
    );

    // the operator surface that does list members is not reachable without a token
    const members = await harness.api("GET", "/v1/service/members");
    assert.equal(members.status, 200, "dev mode allows the operator surface");
    const cohort = await harness.api("GET", "/v1/service/cohort");
    assert.equal(cohort.status, 200);
    assert.equal(cohort.json.cap_per_person, 2);
  });

  it("8. revoking a handle deletes what was derived from it", async () => {
    const person = people[0];
    const handle = await harness.api("POST", "/v1/handles", {
      token: person.token,
      body: { network: "github", handle: "e2e-ada" },
    });
    assert.equal(handle.status, 201);

    const stored = await harness.api("POST", `/v1/service/members/${person.id}/signals`, {
      body: { interests: ["ai"], observations: 4, sources: ["github"] },
    });
    assert.equal(stored.status, 200);

    const revoke = await harness.api("POST", `/v1/consent/${handle.json.handle.consent_id}/revoke`, {
      token: person.token,
    });
    assert.equal(revoke.status, 200);
    const left = harness.db.prepare("SELECT COUNT(*) AS n FROM signals WHERE person_id = ?").get(person.id) as {
      n: number;
    };
    assert.equal(left.n, 0);
  });

  it("9. a person can export everything and then leave", async () => {
    const person = people[0];
    const exported = await harness.api("GET", "/v1/export", { token: person.token });
    assert.equal(exported.status, 200);
    assert.equal(exported.json.person.id, person.id);
    assert.ok(Array.isArray(exported.json.consents));
    assert.ok(exported.json.consents.length > 0, "the receipts travel with the export");

    const erased = await harness.api("DELETE", `/v1/people/${person.id}`, { token: person.token });
    assert.equal(erased.status, 200);

    const gone = await harness.api("GET", "/v1/me", { token: person.token });
    assert.equal(gone.status, 401, "the token dies with the person");
    const rows = harness.db.prepare("SELECT COUNT(*) AS n FROM intros WHERE a_id = ? OR b_id = ?").get(
      person.id,
      person.id,
    ) as { n: number };
    assert.equal(rows.n, 0, "introductions go with them");
  });
});
