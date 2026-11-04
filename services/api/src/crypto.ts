/**
 * Hashing, tokens, one-time codes.
 *
 * Two rules, both non-negotiable:
 *   - Identifiers (phone numbers, handles, emails) are stored only as
 *     HMAC-SHA256 under a server pepper. There is no ciphertext copy to leak and
 *     no plaintext to subpoena out of a database dump.
 *   - Comparison is constant-time. A verification endpoint that leaks timing is
 *     an oracle, and an oracle on a 6-digit code is a 15-minute brute force.
 */

import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

const SIX_DIGITS = 1_000_000;

export function newId(): string {
  return crypto.randomUUID();
}

export function digest(pepper: string, value: string): string {
  return createHmac("sha256", pepper).update(value, "utf8").digest("hex");
}

export function sha256Hex(value: string): string {
  return createHmac("sha256", "tandem-receipt").update(value, "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** A bearer token handed to exactly one person, once, at signup. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256Hex(token) };
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

/** Six digits, uniform, no modulo bias. */
export function newOtpCode(): string {
  return String(randomInt(0, SIX_DIGITS)).padStart(6, "0");
}

export function newNonce(bytes = 12): string {
  return randomBytes(bytes).toString("hex");
}

export function hashOtp(salt: string, code: string): string {
  return createHmac("sha256", salt).update(code, "utf8").digest("hex");
}

/**
 * E.164 normalization, deliberately narrow.
 *
 * We accept what a person can plausibly type for their own number and refuse
 * anything ambiguous. We are verifying control of a number, not resolving it.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const keepPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  if (keepPlus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`; // US/CA convenience
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

/** There is no un-masking. This is what the person's own UI shows them. */
export function phonesHint(e164: string): string {
  const tail = e164.slice(-4);
  const head = e164.slice(0, 2);
  return `${head}${"\u2022".repeat(6)}${tail}`;
}

export function handleHint(handle: string): string {
  const clean = handle.trim();
  return clean.length <= 2 ? clean : `${clean.slice(0, 2)}${"\u2022".repeat(4)}`;
}
