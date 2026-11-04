/**
 * Social proof verification tests.
 *
 * Every network is exercised against a fake fetcher, so these run offline and
 * pin the exact contract: a nonce we generated must be visible on the person's
 * own page before we record anything.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyProofPost, proofInstructions, NETWORKS, oauthAuthorizeUrl } from "../src/social.ts";
import { loadConfig } from "../src/config.ts";

type Call = { url: string; init?: RequestInit };

function fakeFetch(routes: Array<{ match: RegExp; respond: (url: string) => unknown | { status: number } }>) {
  const calls: Call[] = [];
  const fetcher = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    calls.push({ url: target, init });
    const route = routes.find((entry) => entry.match.test(target));
    if (!route) return Promise.reject(new Error(`unexpected fetch: ${target}`));
    const result = route.respond(target);
    if (result && typeof result === "object" && "status" in (result as object) && Object.keys(result as object).length === 1) {
      return Promise.resolve(new Response("nope", { status: (result as { status: number }).status }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
  return { fetcher: fetcher as unknown as (input: string, init?: RequestInit) => Promise<Response>, calls };
}

const NONCE = "abc123def456";

describe("github proofs", () => {
  it("verifies when the nonce is in the bio", async () => {
    const { fetcher } = fakeFetch([
      {
        match: /api\.github\.com\/users\/octocat/,
        respond: () => ({ bio: `building things tandem:${NONCE}`, html_url: "https://github.com/octocat" }),
      },
    ]);
    const result = await verifyProofPost("github", "octocat", NONCE, fetcher);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.evidenceUrl, "https://github.com/octocat");
  });

  it("is case insensitive about the pasted code", async () => {
    const { fetcher } = fakeFetch([
      { match: /api\.github\.com/, respond: () => ({ bio: `TANDEM:${NONCE.toUpperCase()}` }) },
    ]);
    const result = await verifyProofPost("github", "octocat", NONCE, fetcher);
    assert.equal(result.ok, true);
  });

  it("fails cleanly when the code is absent", async () => {
    const { fetcher } = fakeFetch([{ match: /api\.github\.com/, respond: () => ({ bio: "just a person" }) }]);
    const result = await verifyProofPost("github", "octocat", NONCE, fetcher);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && /not in your GitHub bio/.test(result.reason), true);
  });

  it("reports a missing account without throwing", async () => {
    const { fetcher } = fakeFetch([{ match: /api\.github\.com/, respond: () => ({ status: 404 }) }]);
    const result = await verifyProofPost("github", "ghost", NONCE, fetcher);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && /does not exist/.test(result.reason), true);
  });

  it("rejects handles with injection characters before fetching", async () => {
    const { fetcher, calls } = fakeFetch([]);
    await assert.rejects(() => verifyProofPost("github", 'bad"handle', NONCE, fetcher));
    assert.equal(calls.length, 0, "must not fetch a suspicious handle");
  });
});

describe("bluesky proofs", () => {
  it("resolves the did then reads the recent feed", async () => {
    const { fetcher, calls } = fakeFetch([
      { match: /resolveHandle/, respond: () => ({ did: "did:plc:abc" }) },
      {
        match: /getAuthorFeed/,
        respond: () => ({
          feed: [
            { post: { uri: "at://did:plc:abc/app.bsky.feed.post/xyz", record: { text: "hello world" } } },
            { post: { uri: "at://did:plc:abc/app.bsky.feed.post/rkey1", record: { text: `tandem:${NONCE}` } } },
          ],
        }),
      },
    ]);
    const result = await verifyProofPost("bluesky", "@someone.bsky.social", NONCE, fetcher);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.evidenceUrl, "https://bsky.app/profile/someone.bsky.social/post/rkey1");
    assert.equal(calls.length, 2);
  });

  it("fails when the handle does not resolve", async () => {
    const { fetcher } = fakeFetch([{ match: /resolveHandle/, respond: () => ({}) }]);
    const result = await verifyProofPost("bluesky", "nobody.bsky.social", NONCE, fetcher);
    assert.equal(result.ok, false);
  });
});

describe("mastodon proofs", () => {
  it("finds the nonce in the bio", async () => {
    const { fetcher } = fakeFetch([
      {
        match: /fosstodon\.org\/api\/v1\/accounts\/lookup/,
        respond: () => ({ id: "42", url: "https://fosstodon.org/@me", note: `<p>hello tandem:${NONCE}</p>` }),
      },
    ]);
    const result = await verifyProofPost("mastodon", "@me@fosstodon.org", NONCE, fetcher);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.evidenceUrl, "https://fosstodon.org/@me");
  });

  it("falls back to recent posts", async () => {
    const { fetcher } = fakeFetch([
      { match: /accounts\/lookup/, respond: () => ({ id: "42", note: "<p>no code here</p>" }) },
      {
        match: /statuses/,
        respond: () => [{ content: `<p>ok tandem:${NONCE}</p>`, url: "https://fosstodon.org/@me/1" }],
      },
    ]);
    const result = await verifyProofPost("mastodon", "@me@fosstodon.org", NONCE, fetcher);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.evidenceUrl, "https://fosstodon.org/@me/1");
  });

  it("demands the full address", async () => {
    const { fetcher } = fakeFetch([]);
    const result = await verifyProofPost("mastodon", "@justme", NONCE, fetcher);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && /full Mastodon address/.test(result.reason), true);
  });

  it("strips html before comparing", async () => {
    const { fetcher } = fakeFetch([
      { match: /accounts\/lookup/, respond: () => ({ id: "1", note: `<p><strong>tandem:${NONCE}</strong></p>` }) },
    ]);
    const result = await verifyProofPost("mastodon", "@me@example.social", NONCE, fetcher);
    assert.equal(result.ok, true);
  });
});

describe("oauth-only networks", () => {
  it("does not pretend to verify discord by post", async () => {
    const { fetcher } = fakeFetch([]);
    const result = await verifyProofPost("discord", "someone", NONCE, fetcher);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && /authorization/.test(result.reason), true);
  });

  it("refuses to build an authorize url without a client id", () => {
    const config = loadConfig({ dev: true, pepper: "p" });
    assert.throws(() => oauthAuthorizeUrl(config, "discord", "state"), /TANDEM_DISCORD_CLIENT_ID/);
    assert.throws(() => oauthAuthorizeUrl(config, "facebook", "state"), /TANDEM_FACEBOOK_APP_ID/);
  });

  it("builds a scoped discord url when configured", () => {
    const config = loadConfig({
      dev: true,
      pepper: "p",
      social: {
        proofTtlSeconds: 60,
        discordClientId: "12345",
        discordRedirectUri: "https://example.test/cb",
        facebookAppId: "",
        facebookRedirectUri: "",
      },
    });
    const url = new URL(oauthAuthorizeUrl(config, "discord", "state123"));
    assert.equal(url.host, "discord.com");
    assert.equal(url.searchParams.get("scope"), "identify guilds");
    assert.equal(url.searchParams.get("state"), "state123");
  });
});

describe("instructions", () => {
  it("gives every network a paste-ready string", () => {
    for (const network of Object.keys(NETWORKS)) {
      const { steps, paste } = proofInstructions(network, "someone", NONCE);
      assert.ok(steps.length >= 2, network);
      assert.match(paste, /^tandem:/);
    }
  });
});
