/**
 * Client for the Python matching service.
 *
 * The API deliberately owns no scoring logic. If the matcher goes down, Tandem
 * reports that matches are unavailable rather than silently falling back to a
 * worse algorithm — a match you cannot explain is worse than no match.
 */

import type { Config } from "./config.ts";
import { unavailable } from "./errors.ts";

export type MatcherResponse = {
  engine_version: string;
  person_id: string;
  weights: Record<string, number>;
  matches: Array<{
    person_id: string;
    display_name: string;
    score: number;
    breakdown: Record<string, { value: number; weight: number; contribution: number }>;
    reasons: string[];
    blockers: string[];
  }>;
};

export async function requestMatches(
  config: Config,
  subject: unknown,
  candidates: unknown[],
  limit: number,
  fetcher: typeof fetch = fetch,
): Promise<MatcherResponse> {
  let response: Response;
  try {
    response = await fetcher(`${config.matcherUrl.replace(/\/$/, "")}/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject, candidates, limit }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw unavailable(
      `The matching engine is not reachable at ${config.matcherUrl}. ` +
        `Start it with: python -m tandem_matcher (see scripts/dev.sh). Cause: ${(error as Error).message}`,
    );
  }

  if (!response.ok) {
    throw unavailable(`The matching engine returned HTTP ${response.status}.`);
  }
  return (await response.json()) as MatcherResponse;
}
