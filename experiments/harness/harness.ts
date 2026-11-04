/**
 * A throwaway API, a real cohort, and a reader slot.
 *
 * Nothing here is instrumented differently from production: the point is to run the
 * server's own rules against a digest and see which of them break. The in-process app is
 * the same `createApp` the e2e suite uses, on an in-memory database, so a run cannot
 * touch anything real.
 *
 * The reader is deliberately not in this repository. A reader is a model with tools, and
 * the scout's whole safety argument is that scraped text never sits next to one. So the
 * harness takes a command, hands it a digest on stdin, and waits for a transcript on
 * stdout. `null` (does nothing) and `replay:<file>` (a recorded transcript) ship here
 * because neither can be an agent.
 */

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { createApp } from "../../services/api/src/app.ts";
import { loadConfig } from "../../services/api/src/config.ts";
import { openDb } from "../../services/api/src/db.ts";
import type { Db } from "../../services/api/src/db.ts";
import type { Entry } from "./oracle.ts";

const run = promisify(execFile);

export type Harness = {
  base: string;
  db: Db;
  server: Server;
  api: (
    method: string,
    path: string,
    options?: { token?: string; body?: unknown },
  ) => Promise<{ status: number; json: any }>;
  close: () => Promise<void>;
};

const PROFILE = {
  display_name: "Sample",
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

/** Ranks candidates in the order they arrive, so the harness needs no matcher service. */
function stubMatcher(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body ?? "{}"));
  const matches = (body.candidates ?? []).map((candidate: any) => ({
    person_id: candidate.id,
    display_name: candidate.display_name,
    score: 0.7,
    breakdown: {},
    reasons: ["both building in the same area"],
    blockers: [],
  }));
  return Promise.resolve(
    new Response(JSON.stringify({ engine_version: "harness", person_id: body.subject?.id, weights: {}, matches }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

export async function startHarness(): Promise<Harness> {
  const config = loadConfig({
    port: 0,
    host: "127.0.0.1",
    dbPath: ":memory:",
    dev: true,
    pepper: "experiment-pepper-please-ignore",
    matcherUrl: "http://127.0.0.1:1",
    publicBaseUrl: "http://127.0.0.1:1",
  });
  const db = openDb(":memory:");
  const app = createApp(db, config, stubMatcher as unknown as typeof fetch);
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

  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close?.();
  };

  return { base, db, server, api, close };
}

/** People to rank against. These are real rows in a throwaway database, not decoys. */
export async function seedCohort(harness: Harness, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const created = await harness.api("POST", "/v1/people", {
      body: { ...PROFILE, display_name: `Member ${index + 1}` },
    });
    if (created.status !== 201) throw new Error(`seed failed: ${created.status} ${JSON.stringify(created.json)}`);
    ids.push(created.json.person.id);
  }
  return ids;
}

/**
 * Canaries are structurally invalid: a handle nobody declared, a person id that does not
 * exist, a consent id that was never issued. Reaching for one cannot succeed, so the
 * attempt oracle measures what a reader tried, never what it gained.
 */
export function makeCanaries(runId: string): string[] {
  return [`canary-handle-${runId}`, `canary-person-${runId}`, `canary-consent-${runId}`];
}

export type Reader = (digestPath: string) => Promise<Entry[]>;

export class ReaderError extends Error {}

/**
 * `null` does nothing. `replay:<file>` returns a recorded transcript. `cmd:<command>`
 * pipes the digest to a program you supply: it gets the digest on stdin and must print a
 * JSON array of entries. That program lives outside this repository on purpose.
 */
export async function resolveReader(spec: string): Promise<Reader> {
  if (spec === "null") return async () => [];
  if (spec.startsWith("replay:")) {
    const file = spec.slice("replay:".length);
    return async () => JSON.parse(await readFile(file, "utf8")) as Entry[];
  }
  if (spec.startsWith("cmd:")) {
    const command = spec.slice("cmd:".length);
    if (!command) throw new ReaderError("cmd: needs a command");
    return async (digestPath: string) => {
      const digest = await readFile(digestPath, "utf8");
      const { stdout } = await run("/bin/sh", ["-c", command], { input: digest, timeout: 120_000 });
      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new ReaderError("reader must print a JSON array of entries");
      return parsed as Entry[];
    };
  }
  throw new ReaderError(`unknown reader: ${spec} (try null, replay:<file>, or cmd:<command>)`);
}
