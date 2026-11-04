/**
 * Who the rate limiter thinks you are is a security decision, not a detail.
 *
 * The caller writes X-Forwarded-For. If the server believes it without a proxy in front,
 * every per-caller budget is one header away from reset: request codes, browse, introduce.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { callerOf } from "../src/app.ts";

function req(headers: Record<string, string>, remoteAddress = "203.0.113.9") {
  return { headers, socket: { remoteAddress } } as unknown as Parameters<typeof callerOf>[0];
}

const saved = process.env.TANDEM_TRUST_PROXY;
afterEach(() => {
  if (saved === undefined) delete process.env.TANDEM_TRUST_PROXY;
  else process.env.TANDEM_TRUST_PROXY = saved;
});

describe("caller identity", () => {
  it("ignores a forwarded header when no proxy is configured", () => {
    delete process.env.TANDEM_TRUST_PROXY;
    const first = callerOf(req({ "x-forwarded-for": "1.1.1.1" }));
    const second = callerOf(req({ "x-forwarded-for": "2.2.2.2" }));
    assert.equal(first, "203.0.113.9");
    assert.equal(second, "203.0.113.9", "rotating the header must not produce a new identity");
  });

  it("uses the first hop when a proxy is configured", () => {
    process.env.TANDEM_TRUST_PROXY = "1";
    assert.equal(callerOf(req({ "x-forwarded-for": "1.1.1.1, 10.0.0.1" })), "1.1.1.1");
  });

  it("falls back to the socket when the proxy sends nothing", () => {
    process.env.TANDEM_TRUST_PROXY = "1";
    assert.equal(callerOf(req({})), "203.0.113.9");
  });

  it("never returns an empty identity", () => {
    delete process.env.TANDEM_TRUST_PROXY;
    assert.equal(typeof callerOf(req({}, "")), "string");
  });
});
