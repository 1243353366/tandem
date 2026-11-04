# Database

`001_init.sql` is the reference schema (Postgres). The zero-dependency API in
`services/api` runs the same shape on SQLite through Node's built-in `node:sqlite`,
with three dialect differences applied in `services/api/src/db.ts`:

| Postgres | SQLite |
| --- | --- |
| `TEXT` json columns | same (`TEXT` + `json_valid` would be the strict form) |
| partial unique index `WHERE revoked_at IS NULL` | expressed as a unique index on `(kind, subject_hash, revoked_at)` |
| `REFERENCES ... ON DELETE CASCADE` | enabled via `PRAGMA foreign_keys = ON` |

## The invariant

There is no table, column, or index that lets you go from a phone number,
email address, or social handle *to a person you have not heard from*.

The only mapping that exists is `consents.subject_hash -> consents.person_id`,
and it is written by exactly one code path: the person proving control of that
identifier. `services/api/src/policy.ts` enforces this and
`services/api/test/policy.test.ts` fails the build if anyone adds a path around it.

If you fork this and want a people-search engine, you will have to add that table
yourself. That is deliberate.
