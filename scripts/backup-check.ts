/**
 * Prove a copy of the database is a database.
 *
 * Snapshot with VACUUM INTO rather than copying the file. In WAL mode the recent writes live in
 * the -wal file, so a plain copy of the .db can open as an older database, or as one with no
 * tables at all. That is the failure this script exists to make impossible to repeat: it was
 * found by the test next door, in advice that told operators to copy the file.
 *
 * The honest claim is narrow: this checks that a snapshot opens, passes SQLite's own integrity
 * check, and still contains the rows it had. It does not prove a backup schedule
 * exists, that the copy is recent, or that it is stored anywhere safe. Those are the operator's
 * job, and `make backup-check` is what makes the first part checkable rather than assumed.
 *
 *   node scripts/backup-check.ts [path-to-db]
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const source = process.argv[2] ?? process.env.TANDEM_DB ?? "data/tandem.db";

if (!existsSync(source)) {
  console.error(`no database at ${source}. Pass a path, or set TANDEM_DB.`);
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "tandem-backup-"));
const copy = join(scratch, "copy.db");

try {
  const live = new DatabaseSync(source);
  try {
    live.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  } finally {
    live.close();
  }
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
    if (integrity?.integrity_check !== "ok") {
      console.error(`integrity_check said: ${integrity?.integrity_check ?? "nothing"}`);
      process.exit(1);
    }
    const people = Number((db.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n);
    const consents = Number((db.prepare("SELECT COUNT(*) AS n FROM consents").get() as { n: number }).n);
    console.log(
      JSON.stringify(
        {
          source,
          bytes: statSync(source).size,
          integrity: "ok",
          people,
          consents,
          note: "a copy that opens and counts is restorable. A schedule that produces copies is not checked here.",
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
