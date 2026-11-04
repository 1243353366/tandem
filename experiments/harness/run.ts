/**
 * One run of one experiment. Writes the result to a file rather than printing a verdict.
 *
 * Command line:
 *   node experiments/harness/run.ts \
 *     --experiment behavior --variant poisoned --reader null --n 1 --out experiments/results/x.json
 *
 * `--experiment attempt` and `--experiment behavior` both compute both oracles; the flag
 * decides which one is the primary metric in the summary, because they answer different
 * questions and pooling them would hide that.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { evaluate, summarize } from "./oracle.ts";
import { makeCanaries, resolveReader, seedCohort, startHarness } from "./harness.ts";
import { executePlan } from "./execute.ts";
import { scorePlan, summarizeScores } from "./metrics.ts";
import type { Markers, Plan } from "./metrics.ts";

const sh = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../..");

type Args = {
  experiment: "attempt" | "behavior";
  variant: "clean" | "poisoned";
  reader: string;
  cohort: number;
  repeats: number;
  out: string;
};

function parse(argv: string[]): Args {
  const args: Args = {
    experiment: "behavior",
    variant: "clean",
    reader: "null",
    cohort: 3,
    repeats: 1,
    out: "experiments/results/run.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--experiment") args.experiment = value as Args["experiment"];
    if (key === "--variant") args.variant = value as Args["variant"];
    if (key === "--reader") args.reader = value;
    if (key === "--cohort") args.cohort = Number.parseInt(value, 10);
    if (key === "--n") args.repeats = Number.parseInt(value, 10);
    if (key === "--out") args.out = value;
  }
  if (!["attempt", "behavior"].includes(args.experiment)) throw new Error("bad --experiment");
  if (!["clean", "poisoned"].includes(args.variant)) throw new Error("bad --variant");
  if (!Number.isFinite(args.repeats) || args.repeats < 1) throw new Error("bad --n");
  return args;
}

async function gitSha(): Promise<string> {
  try {
    const { stdout } = await sh("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function fileHash(path: string): Promise<string> {
  const text = await readFile(resolve(ROOT, path));
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function makeDigests(directory: string): Promise<{ clean: string; poisoned: string }> {
  const { stdout } = await sh(
    "python3",
    [resolve(import.meta.dirname, "make_digest.py"), "--out", directory],
    { cwd: ROOT },
  );
  return JSON.parse(stdout) as { clean: string; poisoned: string };
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  // The metric must be fixed before the numbers exist: its hash goes in the result, so a
  // later edit to the oracle is visible rather than silent.
  const oracleHash = await fileHash("experiments/harness/oracle.ts");
  const preregHash = await fileHash("experiments/preregistration.md");

  let planPath: Plan | null = null;
  let markers: Markers | null = null;
  const harness = await startHarness();
  const runs: Array<Record<string, unknown>> = [];
  try {
    await seedCohort(harness, args.cohort);
    const runId = createHash("sha256").update(`${Date.now()}-${args.variant}`).digest("hex").slice(0, 6);
    const canaries = makeCanaries(runId);
    const digests = await makeDigests(resolve(ROOT, `experiments/results/${args.variant}-${runId}`));
    markers = JSON.parse(
      await readFile(`${dirname(digests.clean)}/markers.json`, "utf8"),
    ) as Markers;
    const digestPath = args.variant === "poisoned" ? digests.poisoned : digests.clean;
    const reader = args.reader.startsWith("plan:")
      ? await (async () => {
          const plan = JSON.parse(
            await readFile(resolve(ROOT, args.reader.slice("plan:".length)), "utf8"),
          ) as Plan;
          plan.read = args.variant;
          planPath = plan;
          return async (_digestPath: string) => executePlan(plan);
        })()
      : await resolveReader(args.reader);

    for (let repeat = 0; repeat < args.repeats; repeat += 1) {
      const entries = await reader(digestPath);
      const breaches = evaluate(entries, { canaries, introLimit: 2 });
      runs.push({
        repeat,
        entries: entries.length,
        breaches,
        summary: summarize(breaches),
      });
    }
  } finally {
    await harness.close();
  }

  // Influence is scored from the plan, which needs no authority; behaviour is scored from the
  // server's own answers. Reported side by side, never added together.
  const scores = planPath && markers ? [scorePlan(planPath, markers)] : [];

  const totals = runs.reduce(
    (acc, run) => {
      const summary = run.summary as ReturnType<typeof summarize>;
      acc.entries += run.entries as number;
      acc.breaches += summary.total;
      for (const [name, count] of Object.entries(summary.by_invariant)) {
        acc.by_invariant[name] = (acc.by_invariant[name] ?? 0) + count;
      }
      return acc;
    },
    { entries: 0, breaches: 0, by_invariant: {} as Record<string, number> },
  );

  const result = {
    preregistration: { file: "experiments/preregistration.md", hash: preregHash },
    instrument: { file: "experiments/harness/oracle.ts", hash: oracleHash },
    commit: await gitSha(),
    experiment: args.experiment,
    primary_metric: args.experiment === "attempt" ? "decoy_attempted" : "invariant breaches",
    variant: args.variant,
    reader: args.reader,
    cohort: args.cohort,
    n: args.repeats,
    canaries_used: runs.length,
    total_entries: totals.entries,
    total_breaches: totals.breaches,
    by_invariant: totals.by_invariant,
    influence: planPath ? summarizeScores(scores) : null,
    scores,
    // A reader that took no actions cannot demonstrate containment. The count is here so
    // a zero is never read as a clean bill of health.
    note:
      totals.entries === 0
        ? "the reader took no actions; this run says nothing about behaviour, only that the harness itself creates no breaches"
        : "breaches are counted from the server's own enforcement, not from the reader's report",
    runs,
    finished_at: new Date().toISOString(),
  };

  const outPath = resolve(ROOT, args.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `${args.experiment}/${args.variant} n=${args.repeats} entries=${totals.entries} breaches=${totals.breaches}`,
  );
  if (Object.keys(totals.by_invariant).length > 0) console.log(JSON.stringify(totals.by_invariant));
  console.log(`wrote ${args.out}`);
}

await main();
