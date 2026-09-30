# ffp-schema-doc

Build and parse schemaDoc (DDL text) from database introspection rows. Rows in, DDL string out.

This package is **0.x**. The schemaDoc text format is **not a stable contract**. Pin exact versions, since output text may change in minor releases.

## Why I wrote this

I wanted one small, predictable way to turn what a database says about its own tables into a compact block of DDL text that a person, a test, or a downstream tool can read. The output is plain `CREATE TABLE` text, with enum values in comments and foreign keys after the columns.

The job is narrow, so I kept the library narrow. A few choices follow from that, and they are on purpose:

- **Rows in, DDL out is the core.** The builders are pure functions over rows you already have. They do no I/O.
- **The library never opens a database connection.** If you want it to run the shipped SQL for you, you inject a `QueryFn`. It takes no credentials, and `pg` and `mysql2` are not dependencies. You own the connection, the pooling, the role, and the transaction. I did not want to hold your secrets or decide your driver.
- **An empty result is an error by default.** Zero kept column rows almost always means a wrong database name, the wrong schema, missing privileges, or a filter that removed everything. A quiet empty string hides that. `allowEmpty: true` lets you opt in when empty is a valid answer.
- **Typos in filters fail loudly.** An `excludeTables` name that matches nothing throws, because a typo would leave the table you meant to hide in the output.
- **The output format is not promised yet.** That is why this is 0.x and why you should pin exact versions.

## Example

```ts
import { buildDdl, parseSchemaDoc } from 'ffp-schema-doc';

const ddl = buildDdl(
  [
    {
      table_name: 'orders',
      column_name: 'id',
      data_type: 'integer',
      is_nullable: 'NO',
    },
    {
      table_name: 'orders',
      column_name: 'status',
      data_type: 'character varying',
      is_nullable: 'YES',
    },
  ],
  new Map([['orders.status', ['pending', 'completed']]]),
);

// CREATE TABLE orders (
//   id integer NOT NULL,
//   status character varying  -- enum: completed | pending
// );
parseSchemaDoc(ddl);
```

`buildDdl` writes unquoted names, no primary key, and `NOT NULL` only when `is_nullable === 'NO'`. Enum comments look like `  -- enum: a | b`. Foreign-key lines come after the columns.

`buildPostgresSchemaDoc` and `buildMysqlSchemaDoc` still take raw rows. Those functions map foreign-key rows internally. Optional helpers can run the shipped SQL for you; see [Fetching introspection rows](#fetching-introspection-rows).

```ts
import { buildPostgresSchemaDoc } from 'ffp-schema-doc';

const { schemaDoc, tableCount } = buildPostgresSchemaDoc(
  columnRows,
  nativeEnumRows,
  checkRows,
  foreignKeyRows,
);
```

The package exports the row types callers pass in: `SchemaColumnRow`, `SchemaForeignKeyRow`, `PgColumnQueryRow`, `PgNativeEnumQueryRow`, `PgCheckQueryRow`, `PgForeignKeyQueryRow`, `MysqlColumnQueryRow`, `MysqlForeignKeyQueryRow`, and `SchemaDocResult`, plus the parsed-table types `SchemaTableMeta`, `SchemaColumnMeta`, and `SchemaRelationMeta`. It also exports the six SQL constants, `QueryFn`, and the fetch helpers described below.

`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are left off. Turning those flags on would require edits in the files `pnpm diff-bodies` compares.

## Fetching introspection rows

Rows in, DDL out stays the core. `fetchPostgresSchemaDoc` and `fetchMysqlSchemaDoc` are opt-in: they run the shipped statements through a query function you supply, then call the builders above. The package does not open a connection and does not take credentials. `pg` and `mysql2` are not dependencies. The fetch helpers are new in **0.2.0**.

```ts
import { fetchPostgresSchemaDoc, pgQueryFn } from 'ffp-schema-doc';

// `client` is a connected node-postgres Client or Pool that you create.
const { schemaDoc, tableCount, warnings } = await fetchPostgresSchemaDoc(pgQueryFn(client));
```

```ts
import { fetchMysqlSchemaDoc, mysql2QueryFn } from 'ffp-schema-doc';

// `pool` is a mysql2 promise Pool or Connection. `database` is required.
const { schemaDoc } = await fetchMysqlSchemaDoc(mysql2QueryFn(pool), {
  database: 'app',
});
```

`pgQueryFn` ignores `params` and calls `query(sql)` with no second argument. The PostgreSQL statements have no placeholders, and node-postgres treats `query(sql, [])` differently from `query(sql)`. `mysql2QueryFn` accepts the mysql2 promise API. It checks that the result is a `[rows, fields]` tuple and that `rows` is an array. `connection.query(sql, values)` escapes `values` in the client. [`execute`](https://sidorares.github.io/node-mysql2/docs/documentation/prepared-statements) is the prepared-statement API. A caller who wants that can pass their own query function.

`fetchPostgresIntrospectionRows` and `fetchMysqlIntrospectionRows` return the same row arrays the builders take, plus `warnings`. `fetchPostgresSchemaDoc` and `fetchMysqlSchemaDoc` return `{ schemaDoc, tableCount, warnings }`.

### Warnings

`warnings.count` is the number of:

- foreign-key rows dropped because a table is not kept;
- check rows dropped because `includeTables` / `excludeTables` removed that table;
- native-enum rows whose type was used only by a filtered-out table;
- foreign-key rows dropped because a constraint or column name is empty or whitespace-only, or because a MySQL referenced column name is null;
- unmatched filter names.

A null required name is not counted: it throws.

`warnings.messages` are short summaries and do not include database row values. `warnings.unmatched` lists caller-supplied `includeTables` and `excludeTables` names that matched no fetched table. A table the role cannot see is not in the fetched names, so naming it in `excludeTables` is unmatched.

### Options

Options are checked before the first statement.

- `includeTables` / `excludeTables`: arrays of exact `table_name` strings, case-sensitive as the database returned them. A string or any other non-array throws. When both are set, inclusion is applied first: a table is kept only when it is in `includeTables` and not in `excludeTables`. `{ includeTables: ['a', 'b'], excludeTables: ['a'] }` keeps `b`. Omitted means no filter of that kind. `includeTables: []` is an empty allow-list and keeps no tables. `includeTables: ['']` does not match a column row (`table_name` cannot be empty) and is an unmatched name. A name that matches no fetched table is unmatched, including a table the current role cannot see. The same name in both lists is recorded once. Unmatched `excludeTables` names throw, because a typo would leave that table in the document. Unmatched `includeTables` names are recorded on `warnings.unmatched` and do not throw. `strictFilters: true` throws for unmatched include names as well. `strictFilters` must be a boolean when it is set. `strictFilters: false` turns an unmatched exclude name into a warning and does not remove a table.
- `maxTables`: a non-negative integer. `Infinity`, `null`, a string such as `'2'`, `NaN`, fractions, and negative numbers throw before any statement runs. The cap counts distinct kept table names, not column rows and not tables removed by a filter. A view is counted when its `table_name` appears on a column row. Throw when that number is greater than the cap. The helpers do not drop tables to fit the cap. A valid cap is compared after every statement has already returned, so it does not reduce database load.
- `allowEmpty`: default `false`. Zero kept column rows throws an error that names the likely causes (database name, schema `public`, privileges, or a filter that removed every table). That includes an `excludeTables` list that names every fetched table. `allowEmpty: true` returns `{ schemaDoc: '', tableCount: 0 }` plus `warnings` in that case. An unmatched `excludeTables` name still throws when `allowEmpty` is true, unless `strictFilters` is `false`. Calling `buildPostgresSchemaDoc` or `buildMysqlSchemaDoc` with empty arrays returns that empty document and does not throw. The fetch helpers throw on an empty result unless `allowEmpty` is set.
- `signal`: omission and `null` mean no signal. Any other value must have a boolean `aborted` property and a `throwIfAborted` function, which is what `AbortSignal` and `AbortSignal.timeout` provide. A plain object, a string, a number, or an object missing `throwIfAborted` throws `signal must be an AbortSignal` before the first statement. An accepted signal is checked before each statement and again after the last statement, before the builders run. It does not cancel a statement that has already been sent.

`options` itself must be an object when it is passed. `null`, a string, or a number throws `options must be an object` before the first statement and, for MySQL, before the database-name check.

### Limitations

An enum that is used only through an array column is omitted from `schemaDoc` with no warning. PostgreSQL reports that column's `udt_name` as `_typname` (a leading underscore), and the fetch helper matches `typname` exactly.

Composite foreign keys with inconsistent `to_table` values can only occur with synthetic rows. A real catalog gives one referenced table per constraint. When one row's `to_table` is not in the kept set, the fetch layer drops only that row and counts it once in `warnings`. The remaining rows of the same constraint can still be emitted as a shorter partial key. Separately, when rows of one constraint reference different tables and all of those tables are kept, the frozen `groupForeignKeys` silently drops the whole group and `warnings.count` stays 0.

Statements run one after another on the connection you own. They are not wrapped in a transaction, so the result sets are not one snapshot.

A thrown error from the query function is wrapped as `Error` with the query key in the message (`pg.columns: query failed`, and the same shape for the other keys) and the original value as `cause`. The wrapper does not add secrets or connection fields. Driver errors can still carry `host`, `user`, or `sql` on the cause.

Use a least-privilege role that can read metadata. The library cannot force a read-only transaction, because you own the connection. Table names, column names, and enum labels can contain business data. They are copied into `schemaDoc`. Anything you pass that text to, for example an LLM prompt, receives those values. Pass `includeTables` or `excludeTables` when the catalog is wider than that text should be.

A foreign-key row is kept only when both tables are among the kept column rows. This applies even when you do not pass `excludeTables`: a role can see `pg_constraint` and still be unable to read the columns. `to_table` (MySQL: `REFERENCED_TABLE_NAME`) is matched by table name only. A table with the same name in another schema or database can create a false edge. That is a known limitation. Foreign keys dropped because a table is not kept are counted in `warnings`.

`ordinal_position` / `ORDINAL_POSITION` must be a positive integer: a finite integer number `>= 1`, a bigint from `1n` through `Number.MAX_SAFE_INTEGER`, or a string of digits that does not start with `0`. `0`, negatives, and fractions throw.

An empty or whitespace-only `constraint_name`, `from_column`, or `to_column` (MySQL: `CONSTRAINT_NAME`, `COLUMN_NAME`, or `REFERENCED_COLUMN_NAME`, and also a null `REFERENCED_COLUMN_NAME`) drops every row of that constraint, so a composite key is not emitted with a missing column. Those rows are counted in `warnings`. The check is `trim() === ''`. A non-blank name is not rewritten, so `' id '` stays `' id '`. A null or `undefined` required name throws `must be a string` (for example `pg.foreignKeys: constraint_name must be a string`) and is not a warning. `mapPgForeignKeyRows` and `mapMysqlForeignKeyRows` would otherwise drop only the falsy row and could emit the shorter key.

Check rows are passed through only when `buildCheckEnumMap`'s normalization (one leading `public.`, then remove `"`) equals a kept table. A check dropped because the caller filtered that table out is counted. A domain constraint is `conrelid` 0, and `conrelid::regclass::text` is the bare name `-`. A table literally named `-` is quoted by `regclass::text` as `"-"` (or `public."-"`). The helper skips a bare `-` row and does not count it. The quoted form normalizes to `-` and is kept when that table is kept. A name that contains an embedded quote (`"we""ird"` normalizes to `weird`), and a name that does not match any fetched table, are omitted and do not increase `warnings.count`. A dotted name such as `public."a.b"` still matches table `a.b`. Non-public schemas are out of scope for this version.

The native-enum statement has no schema predicate. Two enum types with the same `typname` in different schemas are merged by `typname`. `fetchPostgresIntrospectionRows` keeps a native-enum row when its `typname` equals `udt_name` on a kept column. An enum used only by a table the caller filtered out is counted in `warnings`. An enum that no fetched column uses is omitted and is not counted. A PostgreSQL enum array column reports `udt_name` as `_typname` (a leading underscore). That does not equal `typname`, so those labels are omitted and are not a filter warning unless some other fetched column uses the type name itself.

The library does not sort table names. PostgreSQL order is whatever `ORDER BY table_name` returns. On PostgreSQL 12 and newer, `information_schema` name columns are the domain `sql_identifier` and sort under collation `"C"` ([release notes](https://www.postgresql.org/docs/release/12.0/)). CI initializes PostgreSQL with `C.UTF-8`, so that claim rests on the release notes, not on a non-C database locale in CI. MySQL order is whatever `ORDER BY TABLE_NAME` returns. Do not rely on a specific MySQL order across servers: `INFORMATION_SCHEMA` string columns use `utf8mb3_general_ci`, and identifier case also depends on `lower_case_table_names`. Enum label order follows `LC_ALL` via `localeCompare`.

MySQL `opts.database` is required. `mysql2QueryFn` sends it as a client-escaped `query` value, not as a server-side bind. There is no `SELECT DATABASE()` statement. Choosing `mysql`, `sys`, `performance_schema`, or `information_schema` is the caller's decision; the helper does not reject those names.

## Known limits

I would rather list what the library gets wrong than have you find out in production. These behaviors are pinned by `test/known-limits.test.ts`, `test/degenerate-inputs.test.ts`, and the synthetic goldens. The compared function bodies match the frozen reference snapshot at commit `fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2`. `src/guidance-types.ts` and the exports in `src/index.ts` are not part of that compare. Output-changing fixes are a minor version or higher and are called out in the changelog.

- PostgreSQL column SQL hardcodes `table_schema = 'public'`, and `buildPostgresSchemaDoc` does not apply that filter: a row named `secret_accounts` is still rendered.
- The PostgreSQL foreign-key SQL filters `public` on the referencing table and does not qualify the referenced schema; the rendered line is `REFERENCES regions (id)`, with no `REFERENCES public.`.
- Views are emitted as `CREATE TABLE`. `buildDdl` has no view syntax.
- `parseSchemaDoc` takes the table name with `\w`, so a CJK table name such as `订单` is dropped.
- A CJK column name is dropped by the same `\w` column regex: columns `名称` and `id` parse as `['id']`.
- `order-items`, `order items`, and `order$items` all parse as table name `order`; a table named `$id` parses as no tables.
- A column named `full name` parses as name `full` and type `name`; `$amount` and `unit-price` are dropped.
- `parseSchemaDoc` stores data type `character varying` as type `character`.
- Enum values are sorted with `localeCompare` and no locale argument, so the order follows `LC_ALL`. Measured on Node v22.14.0 (ICU 76.1) for `Ä z a 中文 pending 已完成 A Z aa å ä`: `C.UTF-8` and `en_US.UTF-8` resolve to `en-US` and yield `a A å ä Ä aa pending z Z 中文 已完成`; `zh_CN.UTF-8` resolves to `zh-CN` and yields `已完成 中文` then the Latin tail; `sv_SE.UTF-8` resolves to `sv-SE` and yields `a A aa pending z Z` before `å ä Ä`.
- `MAX_ENUM_VALUES` is 50, and the 51st sorted value is dropped.
- A varchar CHECK is not an enum comment: `parsePgCheckEnum` returns null for `CHECK (((status_code)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))`, and only `= ANY (ARRAY['a'::text, ...])` matches.
- An enum value that contains a comma is split on parse: `Washington, DC` and `NY` become enum values `NY` and `Washington`, and `DC` does not become a column; `(z)`, `w`, and `x,y` become `(z)`, `w`, and `x`.
- An unclosed `(` inside an enum value (`a (b`) keeps the rest of the table body on that line, so later columns are dropped and the enum comment is not parsed.
- A `|` inside an enum value is split: `a|b` and `c` parse as `a`, `b`, and `c`.
- MySQL `''` is not treated as an escaped quote: `enum('it''s','b')` parses as `b`, `it`, and `s`.
- `ordinal_position` uses `Number(x) || 1`, so the string `'2'` stays `2` and `0` becomes `1`; those two rows emit `FOREIGN KEY (b, a)`.
- `buildDdl([])` returns `''`; `buildPostgresSchemaDoc([], [], [], [])` and `buildMysqlSchemaDoc([], [])` return `{ schemaDoc: '', tableCount: 0 }`.
- A self-referential foreign key is emitted: `CONSTRAINT fk_mgr FOREIGN KEY (mgr_id) REFERENCES emp (id)`.
- A foreign key whose `from_table` has no column rows still emits a `CREATE TABLE` that contains only the constraint.
- The same constraint name on two tables is kept as two constraints, because the group key includes the source table.
- Composite foreign keys with inconsistent `to_table` values can only occur with synthetic rows. A real catalog gives one referenced table per constraint. When one row's `to_table` is not in the kept set, the fetch layer drops only that row and counts it once in `warnings`. The remaining rows of the same constraint can still be emitted as a shorter partial key. Separately, when rows of one constraint reference different tables and all of those tables are kept, the frozen `groupForeignKeys` silently drops the whole group and `warnings.count` stays 0.
- `buildDdl` does not emit `PRIMARY KEY`; `parseSchemaDoc` skips a `PRIMARY KEY (a, b)` line and keeps columns `a` and `b`.
- The MySQL path only reads native `ENUM` column types. A `CHECK (col IN (...))` constraint is not turned into an enum comment.
- Adding an export to `src/introspect.ts` passes `pnpm diff-bodies`. Only the bodies of `buildPostgresSchemaDoc` and `buildMysqlSchemaDoc` are compared.
- The fetch helpers run each shipped statement on its own. The result sets are not one transaction snapshot. `signal` is checked between statements and does not cancel a statement that has already been sent. These cases are pinned by `test/introspection-fetch.test.ts`.
- Non-public schemas are out of scope for the fetch helpers. The shipped PostgreSQL column, check, and foreign-key statements read `public`.
- The PostgreSQL native-enum statement has no schema filter. Same-named enum types in different schemas merge by `typname`. The fetch helper keeps enum rows whose `typname` is a kept column's `udt_name`. An enum array's `udt_name` is `_typname` and does not match. Unused enums are omitted and are not counted. Enums used only by a filtered-out table are counted. PostgreSQL table order follows `ORDER BY table_name` under collation `"C"` on PostgreSQL 12+ (`sql_identifier`; see the 12.0 release notes). CI's `C.UTF-8` initdb is not that evidence. The library does not sort MySQL names; `ORDER BY TABLE_NAME` order is the server's, and it is not safe to assume one order across servers. Enum label order follows `LC_ALL`.
- `maxTables` must be a non-negative integer. That check runs before the first statement. Comparing the cap to the number of kept tables happens after the statements have been loaded, and does not reduce database load. The cap counts kept tables, not column rows.
- Foreign-key `to_table` matching is by name only. The same table name in another schema or database can create a false edge.
- An `excludeTables` name that matches no fetched table throws unless `strictFilters` is `false`. An `includeTables` name that matches nothing is a warning unless `strictFilters` is `true`.

## Function bodies

Part of the parsing and grouping code is deliberately frozen against a reference snapshot, so a refactor cannot quietly change the output. `pnpm diff-bodies` is offline. It pins these inputs against the frozen reference snapshot at commit `fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2` (`test/reference/fa3cbe7/`):

- Byte for byte, after rewriting every `from '...'` specifier to `from 'NORMALIZED'`: `src/schema-enum.ts`, `src/schema-parse.ts`, and `src/schema-fk.ts`. Exact `from` lines are also pinned (`schema-parse.ts` imports `./guidance-types`, `schema-fk.ts` imports `./schema-enum`, and `schema-enum.ts` has none), because that rewrite would hide an import-path redirect. `require()` and side-effect `import '...'` are not in those files and are not in the pin list; a one-sided addition still fails the byte compare.
- By function body: `buildPostgresSchemaDoc` and `buildMysqlSchemaDoc` in `src/introspect.ts`, against `datasource.service.ts` lines 230–245 and 341–369. The only normalization is dedent, plus replacing `await this.fetchPostgresNativeEnums(client, rows)`, `await this.fetchPostgresCheckEnums(client)`, `await this.fetchPostgresForeignKeys(client)`, and `await this.fetchMysqlForeignKeys(conn, ds.database)` with `buildNativeEnumMap(rows, nativeEnumRows)`, `buildCheckEnumMap(checkRows)`, `mapPgForeignKeyRows(foreignKeyRows)`, and `mapMysqlForeignKeyRows(foreignKeyRows)`. Any other difference inside those bodies fails. An export added elsewhere in `src/introspect.ts` does not.
- By raw SHA-256 of the reference copies only: `schema-enum.ts`, `schema-parse.ts`, `schema-fk.ts`, `guidance-types.ts`, and `datasource.service.ts` under `test/reference/fa3cbe7/`. Editing a reference copy fails even when `src/` is edited to match. `datasource.service.ts` is not compared as a whole file.

Not pinned: `src/guidance-types.ts` (22 lines; the reference copy is 78 lines, and only that copy's SHA-256 is pinned) and the export list in `src/index.ts`.

`pnpm diff-bodies:prove` checks eight mutation classes, without writing the edit: `MAX_ENUM_VALUES` 50 to 51, a reversed `localeCompare` sort, a widened `parseSchemaDoc` table-name regex, a flipped `buildMysqlSchemaDoc` enum guard, a changed `schema-fk.ts` ordinal fallback, a reference-file byte change that leaves the pinned SHA-256 stale, a `schema-fk.ts` import redirect that normalization would hide, and removing `hashProblems()` or `importProblems()` from `collectGateDiffs` (the function the default path calls). CI runs both commands. `test/known-limits.test.ts` also pins the constant at 50 and the drop of the 51st sorted value.

## Goldens

`test/golden/sample-postgres/` is db-captured from the sample schema (`scripts/seed/`, schema then data) loaded into the disposable database `ffp_schema_doc_capture`. That schema has no native enum and no CHECK constraint. `schema-doc.txt` is `buildDdl` with no foreign keys. `schema-doc-with-fks.txt` includes foreign keys.

`test/golden/synthetic-postgres/` is db-captured from `scripts/sql/synthetic-postgres.sql` into `ffp_schema_doc_capture_pg` (native enum, text CHECK enum, varchar CHECK enum, composite foreign key, view, mixed-case names, CJK table name, CJK enum values). `schema-doc.txt` is the en-US capture. `schema-doc.C.txt`, `schema-doc.en_US.txt`, `schema-doc.zh_CN.txt`, and `schema-doc.sv_SE.txt` were generated on Node v22.14.0 by `scripts/fa3cbe7-postgres-schema-doc.ts` (the committed fa3cbe7 copies, not `buildPostgresSchemaDoc`) under each `LC_ALL`. Tests select the file for the current `LC_ALL` and `assert.equal` the builder output to that literal. An empty `LC_ALL` is not a key and fails. For this schema, `C` and `sv_SE` match `en_US`; `zh_CN` does not.

`test/golden/synthetic-mysql/` is db-captured from `scripts/sql/synthetic-mysql.sql` into `ffp_schema_doc_capture_mysql`. Its per-locale files were generated the same way with `buildMysqlSchemaDoc`, which matches the pinned MySQL slice. There is no separate frozen MySQL composer. `C` and `sv_SE` match `en_US`; `zh_CN` does not.

Postgres rows are `psql` `json_agg` output. MySQL rows are `JSON_OBJECT` output. They are not `pg` or `mysql2` driver values, so driver coercions (`ordinal_position` as a string or BigInt, `Buffer`) are not in the goldens. `Number(r.ordinal_position) || 1` can hide those coercions. The unit tests replay those JSON files through a fake query function. `.github/workflows/integration.yml` loads the synthetic scripts into `postgres:16.15` and `mysql:8.0.46` and compares `schemaDoc` from real `pg` and `mysql2` clients to the `C.UTF-8` golden. Those tags are pinned on purpose: the goldens were captured on PostgreSQL 16.15 and MySQL 8.0.46. A later minor release can change CHECK text from `pg_get_constraintdef`. When that happens, re-capture with `pnpm capture-golden` and review the diff before replacing the golden. The workflow still passes `--locale=C.UTF-8` to `initdb`. That does not decide PostgreSQL table order: on PostgreSQL 12+ `information_schema.columns.table_name` sorts with collation `"C"`.

Each `metadata.json` records the SHA-256 of the six introspection SQL strings from `datasource.service.ts` at the pinned commit. The same hashes are stored in `test/fixtures/introspection-sql.sha256.json` for the constants in `src/introspection-sql.ts`. `scripts/capture-golden.ts` will only `DROP` a database named `ffp_schema_doc_capture`, `ffp_schema_doc_capture_pg`, or `ffp_schema_doc_capture_mysql`.

Regenerate locally (Postgres and MySQL on the machine, peer/socket auth, no credentials in the repo):

```bash
pnpm capture-golden
```

## Develop

```bash
pnpm install
LC_ALL=en_US.UTF-8 pnpm test
pnpm diff-bodies
pnpm diff-bodies:prove
pnpm check-standalone
pnpm build
```

`pnpm test` does not need a database. `pnpm test:integration` loads `scripts/sql/synthetic-postgres.sql` and `scripts/sql/synthetic-mysql.sql` through real `pg` and `mysql2` clients. It reads `SCHEMA_DOC_PG_*` and `SCHEMA_DOC_MYSQL_*` from the environment and fails when they are missing. It only resets databases named `ffp_schema_doc_capture_pg` and `ffp_schema_doc_capture_mysql`.

Run the suite as `LC_ALL=en_US.UTF-8 pnpm test`, or with any of `C.UTF-8`, `en_US.UTF-8`, `zh_CN.UTF-8`, and `sv_SE.UTF-8`. An empty or unlisted `LC_ALL` intentionally fails the golden tests. The test script quotes `test/**/*.test.ts` so the shell does not expand the glob. `engines` stays `node >= 20`. The library does not require Node 21.

`pnpm check-standalone` scans tracked file paths, file contents, and `package.json`. The term list is built by joining fragments, and the allow-list is empty. CI runs it.

CI runs on Node 22 with pnpm 10.33.3 under `LC_ALL` of `C.UTF-8`, `en_US.UTF-8`, `zh_CN.UTF-8`, and `sv_SE.UTF-8`, and logs `process.versions.icu` plus the resolved Intl locale.

The package builds to CommonJS with shipped `.d.ts` types. There is no dual ESM build.

## Publish

Tags must be `vX.Y.Z`. Any other tag, including prereleases, fails the workflow. Prereleases are not published under `--tag next`. The test job and the publish job each run `scripts/check-publish-tag.mjs` and fail unless the tag equals `v` plus the `package.json` version. The publish job runs that check before the publish step. The tagged commit must be an ancestor of `origin/main`. `ci.yml` and `integration.yml` must each already have a successful run for that commit. If either run is missing or not successful, the publish job fails and names that workflow. `integration.yml` already runs on pushes to `main`, so a commit that landed on `main` can satisfy that check.

Before tagging a release, configure an npm trusted publisher for repository `FFP-Tech-Lab/ffp-schema-doc`, workflow file `publish-npm.yml`, and environment `npm-publish`. Also make the `integration.yml` check required on `main`. Publishing uses that OIDC trusted publisher only. The publish command unsets `NODE_AUTH_TOKEN`.

The publish workflow has two jobs. `test` has `contents: read` only and sets `LC_ALL=C.UTF-8` (present on GitHub ubuntu runners). The test step logs `echo $LC_ALL` and `locale` before `pnpm test`. `publish` needs `test`, uses the `npm-publish` environment, and has `contents: read`, `id-token: write`, and `actions: read` (the last is what lets the job read the `ci.yml` and `integration.yml` runs for this commit). The publish job does not run the test suite.

The publish job installs Node 22, then `npm install -g npm@^11.5.1` and logs `npm --version`. OIDC trusted publishing needs npm 11.5.1 or newer, and Node 22 bundles npm 10.x. It installs dependencies with `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm build`, which writes `dist` before any publish step. Publish uses `npm publish`, not `pnpm publish`. The publish command passes `--ignore-scripts`, so `prepack` (`pnpm build`) does not run again and cannot read `NODE_AUTH_TOKEN`.

If this version is already on the registry, the job compares the published `gitHead` to the tagged commit and the published `dist.integrity` to a local `npm pack`. A match skips publish. A mismatch fails. A transient `npm view` error fails the job. When this version is not on the registry yet, the job publishes with OIDC trusted publishing (`NODE_AUTH_TOKEN` unset).

The publish command passes `--provenance` and `--ignore-scripts`. Provenance is a sigstore attestation signed with the workflow OIDC token. It is separate from registry login.
