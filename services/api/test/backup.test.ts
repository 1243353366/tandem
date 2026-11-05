/**
 * The README tells operators that an untested backup does not count as a backup. This is the
 * test that has to keep that sentence honest: a copy of the database must open, pass SQLite's
 * integrity check, and still hold the rows it held.
 */

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";

import { openDb } from "../src/db.ts";
import { createPerson } from "../src/store.ts";
import type { Db } from "../src/db.ts";

let workdir: string;
let db: Db;
let dbPath: string;

describe("a backup that can be restored", () => {
  before(() => {
    workdir = mkdtempSync(join(tmpdir(), "tandem-backup-test-"));
    dbPath = join(workdir, "live.db");
    db = openDb(dbPath);
    // Same shape the HTTP intake sends, minus anything the insert does not bind.
    createPerson(db, {
      display_name: "Ada",
      headline: "infra",
      location_city: "Brooklyn",
      interests: ["ai"],
      project_tags: ["python"],
      current_project: "an evidence tool",
      hours_per_week: 6,
      looking_for: ["cofounder"],
      offers: ["cofounder"],
      timezone: "America/New_York",
      comm_style: { pace: "async", directness: 3, group_size: "small", prefers: ["text"] },
      visibility: "listed",
      looking_for_kinds: ["cofounder"],
    }, "test-token-hash");
  });

  after(() => {
    db.close();
    rmSync(workdir, { recursive: true, force: true });
  });

  it("restores from a VACUUM INTO snapshot and still holds the row", () => {
    const copy = join(workdir, "copy.db");
    db.exec(`VACUUM INTO '${copy}'`);

    const restored = new DatabaseSync(copy, { readOnly: true });
    try {
      const integrity = restored.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      assert.equal(integrity.integrity_check, "ok");
      const people = restored.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number };
      assert.equal(people.n, 1, "the copy is not an empty database that passes by being empty");
    } finally {
      restored.close();
    }
  });

  it("a plain file copy is not a backup, because the recent writes are in the WAL", () => {
    const naive = join(workdir, "naive.db");
    copyFileSync(dbPath, naive);

    let rows = 0;
    let failed = false;
    try {
      const copy = new DatabaseSync(naive, { readOnly: true });
      try {
        rows = Number((copy.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n);
      } finally {
        copy.close();
      }
    } catch {
      failed = true;
    }
    assert.ok(
      failed || rows === 0,
      "if this ever passes with rows, the WAL assumption changed and the README advice needs rewriting",
    );
  });
});
