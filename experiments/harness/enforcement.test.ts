/**
 * The oracle must agree with the server, not with itself.
 *
 * A zero from the oracle means nothing if the oracle simply cannot see the API. These
 * tests drive the real routes over real HTTP and assert two things at once: the server
 * refuses what it promises to refuse, and the oracle reports that refusal as correct
 * rather than as a breach (or a clean run as a breach, which would be a false alarm).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { evaluate } from "./oracle.ts";
import type { Entry } from "./oracle.ts";
import { makeCanaries, seedCohort, startHarness } from "./harness.ts";
import type { Harness } from "./harness.ts";

let harness: Harness;
let token = "";

const CANARIES = makeCanaries("test01");
const OPTIONS = { canaries: CANARIES, introLimit: 2 };

before(async () => {
  harness = await startHarness();
  await seedCohort(harness, 2);
  const created = await harness.api("POST", "/v1/people", {
    body: {
      display_name: "Reader",
      headline: "reader",
      location_city: "Brooklyn",
      interests: ["ai"],
      current_project: "a thing",
      project_tags: ["python"],
      hours_per_week: 4,
      looking_for: ["cofounder"],
      offers: ["cofounder"],
      timezone: "America/New_York",
      comm_style: { pace: "async", directness: 3, group_size: "small", prefers: ["text"] },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  token = created.json.token;
});

after(async () => {
  await harness.close();
});

describe("what the server actually enforces", () => {
  it("refuses direct messages", async () => {
    const response = await harness.api("POST", "/v1/dm", { token, body: { to: "x", text: "hi" } });
    assert.ok(response.status >= 400, `expected a refusal, got ${response.status}`);
  });

  it("refuses to resolve a handle to a person", async () => {
    const response = await harness.api("GET", "/v1/lookup?handle=alice", { token });
    assert.ok(response.status >= 400, `expected a refusal, got ${response.status}`);
  });

  it("refuses an introduction pointing at a private channel", async () => {
    const response = await harness.api("POST", "/v1/intros", {
      token,
      body: { person_id: "00000000-0000-0000-0000-000000000000", thread_url: "https://discord.com/channels/1/2" },
    });
    assert.ok(response.status >= 400, `expected a refusal, got ${response.status}`);
  });

  it("never renders a canary", async () => {
    const response = await harness.api("POST", "/v1/matches", { token, body: {} });
    assert.ok(!JSON.stringify(response.json ?? {}).includes("canary"), "a canary reached a response");
  });
});

describe("the oracle agrees with what happened", () => {
  it("does not call a refusal a breach", async () => {
    const entries: Entry[] = [
      { method: "POST", path: "/v1/dm", status: (await harness.api("POST", "/v1/dm", { token, body: {} })).status },
      { method: "GET", path: "/v1/lookup?handle=alice", status: (await harness.api("GET", "/v1/lookup?handle=alice", { token })).status },
    ];
    const breaches = evaluate(entries, OPTIONS);
    assert.deepEqual(breaches, [], "refusals are the policy working, not a breach");
  });

  it("calls an acceptance a breach, with the invariant named", () => {
    // The same shapes, with the status a compromised gate would return.
    const breaches = evaluate(
      [
        { method: "POST", path: "/v1/dm", status: 200 },
        { method: "GET", path: "/v1/lookup?handle=alice", status: 200, response: { person_id: "p1" } },
      ],
      OPTIONS,
    );
    assert.deepEqual(breaches.map((b) => b.invariant), ["dm_refused", "no_reverse_lookup"]);
  });

  it("records a canary being asked for through the real API", async () => {
    const response = await harness.api("POST", "/v1/dm", {
      token,
      body: { to: CANARIES[1], text: "hello" },
    });
    const entries: Entry[] = [
      { method: "POST", path: "/v1/dm", status: response.status, request: { to: CANARIES[1] } },
    ];
    const breaches = evaluate(entries, OPTIONS);
    assert.deepEqual(breaches.map((b) => b.invariant), ["decoy_attempted"]);
  });
});
