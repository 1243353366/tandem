/**
 * The invariant that makes this product defensible.
 *
 * A matching network only needs one capability: given a person, find people.
 * That is what every function here supports, and it is the *only* direction of
 * travel. The inverse capability, "given a phone number or handle, find the
 * person", is what turns the same database into a stalking tool, a doxxing
 * service, or a scraper's upstream. It is not a feature we have not gotten to.
 * It is refused.
 *
 * `assertNoReverseLookup` is called by every route handler that receives an
 * identifier, and the test suite fails the build if a route is added that skips
 * it. If you fork this project: this file is the thing worth keeping.
 */

export const REVERSE_LOOKUP_REFUSED = {
  error: "reverse_lookup_not_supported",
  message:
    "Tandem does not map a phone number, email address, or social handle to a " +
    "person. Identifiers are one-way hashes at rest and are only ever written by " +
    "the person who proved control of them. If you believe someone should be on " +
    "Tandem, send them the signup link.",
  docs: "/docs/consent-model.md#no-reverse-lookup",
} as const;

/** Route names that must never exist. Kept explicit so a diff cannot sneak one in. */
export const FORBIDDEN_ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/v1\/lookup$/,
  /^\/v1\/search$/,
  /^\/v1\/find$/,
  /^\/v1\/people\/by-(phone|email|handle|subject)/,
  /^\/v1\/resolve$/,
];

export function isForbiddenRoute(path: string): boolean {
  return FORBIDDEN_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Guards a handler's inputs. Called with the parsed body of any endpoint; if the
 * body carries an identifier *without* an accompanying proof flow, the handler
 * is about to become a lookup and we stop it.
 */
export function assertNoReverseLookup(body: unknown, proofProvided: boolean): void {
  if (proofProvided) return;
  if (typeof body !== "object" || body === null) return;
  const keys = Object.keys(body as Record<string, unknown>).map((k) => k.toLowerCase());
  const identifiers = ["phone", "phone_number", "email", "handle", "username", "subject"];
  const found = keys.filter((key) => identifiers.includes(key));
  if (found.length > 0) {
    const error = new Error(
      `identifier fields (${found.join(", ")}) require a proof flow; refusing to treat this as a lookup`,
    );
    (error as Error & { code?: string }).code = "reverse_lookup";
    throw error;
  }
}

/** How many identifiers we are willing to keep per person. */
export const MAX_CONSENTS_PER_PERSON = 8;
