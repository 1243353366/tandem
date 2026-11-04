/**
 * Consent: the phone verification flow and the receipts it produces.
 *
 * A consent receipt is a small, verifiable record of four things:
 *   who granted it, which identifier, what it may be used for, and until when.
 *
 * The hash is computed over a canonical body so the person (or an auditor) can
 * recompute it from the exported JSON. That is the whole point: a receipt you
 * cannot verify yourself is a promise, not a receipt.
 */

import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { PersonRow } from "./store.ts";
import { digest, hashOtp, newNonce, newOtpCode, normalizePhone, phonesHint, safeEqual, sha256Hex } from "./crypto.ts";
import { badRequest, conflict, notFound, tooMany } from "./errors.ts";
import {
  bumpChallengeAttempts,
  consumeChallenge,
  createChallenge,
  findLiveConsentBySubject,
  getChallenge,
  insertConsent,
  liveConsents,
  recentChallengeCount,
} from "./store.ts";
import { MAX_CONSENTS_PER_PERSON } from "./policy.ts";

export const DEFAULT_SCOPES = ["identity.verify", "match.signals"];

export type ReceiptBody = {
  v: 1;
  person_id: string;
  kind: string;
  subject_hash: string;
  scope: string[];
  policy_version: string;
  granted_at: string;
  expires_at: string | null;
};

/** Deterministic canonical form: sorted keys, no whitespace. */
export function canonicalize(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const pairs = keys.map((key) => {
    const inner = value[key];
    const rendered = Array.isArray(inner)
      ? `[${inner.map((item) => JSON.stringify(item)).join(",")}]`
      : JSON.stringify(inner ?? null);
    return `${JSON.stringify(key)}:${rendered}`;
  });
  return `{${pairs.join(",")}}`;
}

export function receiptHash(body: ReceiptBody): string {
  return sha256Hex(canonicalize(body as unknown as Record<string, unknown>));
}

/**
 * SMS delivery.
 *
 * Tandem ships without an SMS vendor on purpose: pulling in a provider is a
 * decision with a billing relationship attached, and it should be made by the
 * person deploying this. Set TANDEM_SMS_WEBHOOK to any URL that accepts
 * `{"to": "+1...", "body": "..."}` and it will be called. In dev mode the code
 * is returned in the response instead.
 */
async function sendSms(config: Config, to: string, body: string): Promise<void> {
  const webhook = process.env.TANDEM_SMS_WEBHOOK;
  if (!webhook) {
    // In dev mode the code comes back in the response, so nothing is lost here.
    if (!config.dev) {
      console.error(
        `[tandem] no TANDEM_SMS_WEBHOOK configured; SMS to ${phonesHint(to)} was not delivered`,
      );
    }
    return;
  }
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, body }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    console.error(`[tandem] SMS webhook returned ${response.status}`);
  }
}

export async function startPhoneConsent(
  db: Db,
  config: Config,
  person: PersonRow,
  phoneRaw: unknown,
  now: () => number = Date.now,
) {
  const phone = normalizePhone(phoneRaw);
  if (!phone) {
    throw badRequest(
      "That does not look like a phone number. Use digits with a country code, e.g. +1 555 010 0199.",
    );
  }

  if (liveConsents(db, person.id).length >= MAX_CONSENTS_PER_PERSON) {
    throw conflict("This account already has the maximum number of verified identifiers.");
  }

  if (recentChallengeCount(db, person.id) >= config.otp.maxPerHour) {
    throw tooMany("Too many verification codes requested. Try again in an hour.");
  }

  const phoneHash = digest(config.pepper, `phone:${phone}`);

  // Already verified by this same person: no new code, no new consent row.
  const existing = findLiveConsentBySubject(db, "phone", phoneHash);
  if (existing && existing.person_id === person.id) {
    return {
      status: "already_verified" as const,
      consent_id: existing.id,
      hint: existing.subject_hint,
    };
  }

  const code = newOtpCode();
  const salt = newNonce(16);
  const { id, expiresAt } = createChallenge(db, {
    phoneHash,
    phoneHint: phonesHint(phone),
    codeHash: hashOtp(salt, code),
    salt,
    ttlSeconds: config.otp.ttlSeconds,
    personId: person.id,
  });

  await sendSms(
    config,
    phone,
    `Tandem verification code: ${code}. It expires in ${Math.round(config.otp.ttlSeconds / 60)} minutes. ` +
      `If you did not request this, ignore it.`,
  );

  return {
    status: "code_sent" as const,
    challenge_id: id,
    expires_at: expiresAt,
    hint: phonesHint(phone),
    // Only populated in dev mode, and only because there is no real SMS path.
    ...(config.dev ? { dev_code: code } : {}),
  };
}

export function verifyPhoneConsent(
  db: Db,
  config: Config,
  person: PersonRow,
  body: unknown,
) {
  if (typeof body !== "object" || body === null) {
    throw badRequest("body must be a JSON object");
  }
  const input = body as Record<string, unknown>;
  const challengeId = String(input.challenge_id ?? "");
  const code = String(input.code ?? "").replace(/\D/g, "");

  if (!challengeId || code.length !== 6) {
    throw badRequest("challenge_id and a six-digit code are required.");
  }

  const challenge = getChallenge(db, challengeId);
  if (!challenge || challenge.person_id !== person.id) {
    throw notFound("That verification code has expired. Request a new one.");
  }
  if (challenge.consumed_at) {
    throw conflict("That code was already used. Request a new one.");
  }
  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    throw badRequest("That code expired. Request a new one.");
  }
  if (challenge.attempts >= config.otp.maxAttempts) {
    throw tooMany("Too many incorrect attempts on this code. Request a new one.");
  }

  bumpChallengeAttempts(db, challenge.id);
  if (!safeEqual(hashOtp(challenge.salt, code), challenge.code_hash)) {
    const remaining = Math.max(0, config.otp.maxAttempts - challenge.attempts - 1);
    throw badRequest(`That code is not right. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`);
  }

  consumeChallenge(db, challenge.id);

  // At this point the caller has proven control of the number, so telling them
  // it is already used is no longer an oracle: they hold the phone.
  const existing = findLiveConsentBySubject(db, "phone", challenge.phone_hash);
  if (existing && existing.person_id !== person.id) {
    throw conflict(
      "This number is already verified on another Tandem account. " +
        "If that is your account, sign in there or revoke the consent first.",
    );
  }
  if (existing && existing.person_id === person.id) {
    return { status: "already_verified" as const, consent_id: existing.id };
  }

  const grantedAt = new Date().toISOString();
  const receipt: ReceiptBody = {
    v: 1,
    person_id: person.id,
    kind: "phone",
    subject_hash: challenge.phone_hash,
    scope: DEFAULT_SCOPES,
    policy_version: config.policyVersion,
    granted_at: grantedAt,
    expires_at: null,
  };

  const consent = insertConsent(db, {
    personId: person.id,
    kind: "phone",
    subjectHash: challenge.phone_hash,
    subjectHint: challenge.phone_hint || "",
    scope: DEFAULT_SCOPES,
    policyVersion: config.policyVersion,
    expiresAt: null,
    receiptHash: receiptHash(receipt),
    evidence: { method: "otp_sms", challenge_id: challenge.id, attempts: challenge.attempts + 1 },
  });

  return {
    status: "verified" as const,
    consent_id: consent.id,
    receipt: { ...receipt, receipt_hash: consent.receipt_hash },
  };
}
