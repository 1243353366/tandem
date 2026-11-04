/**
 * The executor: the boundary that makes a reader safe to plug in.
 *
 * The reader decides; this program acts, and it will only act inside its envelope. Anything
 * aimed at another host, or at a path that is not a /v1 route, is recorded as a refusal and
 * never sent. So a poisoned plan's exfiltration step becomes a line in a result file instead
 * of a request to the internet, and the run stays measurable.
 *
 * Transcript entries carry the server's real status. A refusal by the executor is status 0
 * with `by: "executor"`, so it can never be mistaken for a real 4xx.
 */

import { readFile, writeFile } from "node:fs/promises";

import { inEnvelope } from "./metrics.ts";
import type { Plan } from "./metrics.ts";
import { seedCohort, startHarness } from "./harness.ts";
import type { Entry } from "./oracle.ts";

const MAX_ACTIONS = 20;

const PROFILE = {
  display_name: "Reader",
  headline: "reader",
  location_city: "Brooklyn",
  interests: ["ai", "security"],
  current_project: "a thing",
  team_size: 1,
  hours_per_week: 4,
  looking_for: ["cofounder"],
  offers: ["cofounder"],
  timezone: "America/New_York",
  comm_style: { pace: "async", directness: 3, group_size: "small", prefers: ["text"] },
};

export async function executePlan(plan: Plan): Promise<Entry[]> {
  const harness = await startHarness();
  const entries: Entry[] = [];
  try {
    const cohort = await seedCohort(harness, 3);
    const created = await harness.api("POST", "/v1/people", { body: PROFILE });
    if (created.status !== 201) throw new Error(`reader could not register: ${created.status}`);
    const token = created.json.token;

    const resolve = (value: unknown): unknown => {
      if (typeof value === "string") {
        const index = /^COHORT\[(\d+)\]$/.exec(value);
        if (index) return cohort[Number(index[1])] ?? value;
        return value;
      }
      if (Array.isArray(value)) return value.map(resolve);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
      }
      return value;
    };

    for (const raw of plan.actions.slice(0, MAX_ACTIONS)) {
      const action = { ...raw, body: resolve(raw.body) };
      if (!inEnvelope(action)) {
        entries.push({
          method: action.method,
          path: String(action.path ?? ""),
          status: 0,
          request: action.body,
          response: { by: "executor", refused: "outside the envelope; nothing was sent" },
          label: action.why,
        });
        continue;
      }
      // A body on a GET makes fetch throw, which would look like a reader failure rather than
      // a plan mistake. Send one only where HTTP allows it.
      const withBody = !["GET", "HEAD"].includes(action.method.toUpperCase());
      const response = await harness.api(action.method, action.path, {
        token,
        body: withBody ? action.body : undefined,
      });
      entries.push({
        method: action.method,
        path: action.path,
        status: response.status,
        request: action.body,
        response: response.json,
        label: action.why,
      });
    }
  } finally {
    await harness.close();
  }
  return entries;
}

async function main(): Promise<void> {
  const [planPath, outPath] = process.argv.slice(2);
  if (!planPath || !outPath) throw new Error("usage: execute.ts <plan.json> <transcript.json>");
  const plan = JSON.parse(await readFile(planPath, "utf8")) as Plan;
  const entries = await executePlan(plan);
  await writeFile(outPath, `${JSON.stringify(entries, null, 2)}\n`);
  const sent = entries.filter((entry) => entry.status !== 0).length;
  console.log(`${plan.read}: ${entries.length} actions, ${sent} sent, ${entries.length - sent} refused by the executor`);
}

if (import.meta.main) await main();
