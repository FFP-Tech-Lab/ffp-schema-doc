# ffp-schema-doc

Build and parse schemaDoc (DDL text) from database introspection rows. Rows in, DDL string out.

This package is **0.x**. The schemaDoc text format is **not a stable contract**. Pin exact versions, since output text may change in minor releases.

Experimental renderers are not part of this package.

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

PostgreSQL and MySQL callers keep their SQL and pass the raw rows to `buildPostgresSchemaDoc` or `buildMysqlSchemaDoc`. Those functions map foreign-key rows internally.

```ts
import { buildPostgresSchemaDoc } from 'ffp-schema-doc';

const { schemaDoc, tableCount } = buildPostgresSchemaDoc(
  columnRows,
  nativeEnumRows,
  checkRows,
  foreignKeyRows,
);
```

Pin exact versions, since output text may change in minor releases.

The package exports the row types callers pass in: `SchemaColumnRow`, `SchemaForeignKeyRow`, `PgColumnQueryRow`, `PgNativeEnumQueryRow`, `PgCheckQueryRow`, `PgForeignKeyQueryRow`, `MysqlColumnQueryRow`, `MysqlForeignKeyQueryRow`, and `SchemaDocResult`, plus the parsed-table types `SchemaTableMeta`, `SchemaColumnMeta`, and `SchemaRelationMeta`.

`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are left off. The implementation sources match a frozen reference snapshot, and turning those flags on would require edits the body diff forbids.

## Known limits

These behaviors are pinned by `test/known-limits.test.ts`, `test/degenerate-inputs.test.ts`, and the synthetic goldens. The implementation matches the frozen reference snapshot at commit `fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2`. Output-changing fixes are a minor version or higher and are called out in the changelog.

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
- A foreign-key group whose rows name different `to_table` values is dropped.
- `buildDdl` does not emit `PRIMARY KEY`; `parseSchemaDoc` skips a `PRIMARY KEY (a, b)` line and keeps columns `a` and `b`.
- The MySQL path only reads native `ENUM` column types. A `CHECK (col IN (...))` constraint is not turned into an enum comment.

## Function bodies

`pnpm diff-bodies` compares `schema-enum.ts`, `schema-parse.ts`, and `schema-fk.ts` to the frozen reference snapshot of the original implementation at commit `fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2` (`test/reference/fa3cbe7/`) as whole files. Import specifiers are normalized (`from '...'` becomes `from 'NORMALIZED'`). That rewrite hides an import-path redirect, so the script also pins the exact `from` lines (`schema-parse.ts` imports `./guidance-types`, `schema-fk.ts` imports `./schema-enum`, and `schema-enum.ts` has none). `require()` and side-effect `import '...'` are not in those files and are not in the pin list; a one-sided addition still fails the byte compare. Each reference file's raw SHA-256 is pinned, including `guidance-types.ts` and `datasource.service.ts`, so editing a reference copy fails even when `src/` is edited to match. The script is offline.

`buildPostgresSchemaDoc` and `buildMysqlSchemaDoc` are new. The script compares each function body to an explicit line range of the frozen `datasource.service.ts` (lines 230–245 and 341–369). The only normalization is dedent, plus replacing `await this.fetchPostgresNativeEnums(client, rows)`, `await this.fetchPostgresCheckEnums(client)`, `await this.fetchPostgresForeignKeys(client)`, and `await this.fetchMysqlForeignKeys(conn, ds.database)` with `buildNativeEnumMap(rows, nativeEnumRows)`, `buildCheckEnumMap(checkRows)`, `mapPgForeignKeyRows(foreignKeyRows)`, and `mapMysqlForeignKeyRows(foreignKeyRows)`. Any other difference fails.

`pnpm diff-bodies:prove` checks, without writing the edit, that the compare fails for `MAX_ENUM_VALUES` 50 to 51, a reversed `localeCompare` sort, a widened `parseSchemaDoc` table-name regex, a flipped `buildMysqlSchemaDoc` enum guard, a changed `schema-fk.ts` ordinal fallback, a reference-file byte change that leaves the pinned SHA-256 stale, and a `schema-fk.ts` import redirect that normalization would hide. CI runs both commands. `test/known-limits.test.ts` also pins the constant at 50 and the drop of the 51st sorted value.

## Goldens

`test/golden/sample-postgres/` is db-captured from the sample schema (`scripts/seed/`, schema then data) loaded into the disposable database `ffp_schema_doc_capture`. That schema has no native enum and no CHECK constraint. `schema-doc.txt` is `buildDdl` with no foreign keys. `schema-doc-with-fks.txt` includes foreign keys.

`test/golden/synthetic-postgres/` is db-captured from `scripts/sql/synthetic-postgres.sql` into `ffp_schema_doc_capture_pg` (native enum, text CHECK enum, varchar CHECK enum, composite foreign key, view, mixed-case names, CJK table name, CJK enum values). `schema-doc.txt` is the en-US capture. `schema-doc.C.txt`, `schema-doc.en_US.txt`, `schema-doc.zh_CN.txt`, and `schema-doc.sv_SE.txt` were generated on Node v22.14.0 by `scripts/fa3cbe7-postgres-schema-doc.ts` (the committed fa3cbe7 copies, not `buildPostgresSchemaDoc`) under each `LC_ALL`. Tests select the file for the current `LC_ALL` and `assert.equal` the builder output to that literal. An empty `LC_ALL` is not a key and fails. For this schema, `C` and `sv_SE` match `en_US`; `zh_CN` does not.

`test/golden/synthetic-mysql/` is db-captured from `scripts/sql/synthetic-mysql.sql` into `ffp_schema_doc_capture_mysql`. Its per-locale files were generated the same way with `buildMysqlSchemaDoc`, which matches the pinned MySQL slice. There is no separate frozen MySQL composer. `C` and `sv_SE` match `en_US`; `zh_CN` does not.

Postgres rows are `psql` `json_agg` output. MySQL rows are `JSON_OBJECT` output. They are not `pg` or `mysql2` driver values, so driver coercions (`ordinal_position` as a string or BigInt, `Buffer`) are not in the goldens. `Number(r.ordinal_position) || 1` can hide those coercions. Callers that run their own SQL should hash it, or integration-test it, against the exported row types.

Each `metadata.json` records the SHA-256 of the six introspection SQL strings from `datasource.service.ts` at the pinned commit. `scripts/capture-golden.ts` will only `DROP` a database named `ffp_schema_doc_capture`, `ffp_schema_doc_capture_pg`, or `ffp_schema_doc_capture_mysql`.

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

Run the suite as `LC_ALL=en_US.UTF-8 pnpm test`, or with any of `C.UTF-8`, `en_US.UTF-8`, `zh_CN.UTF-8`, and `sv_SE.UTF-8`. An empty or unlisted `LC_ALL` intentionally fails the golden tests. The test script quotes `test/**/*.test.ts` so the shell does not expand the glob. `engines` stays `node >= 20`. The library does not require Node 21.

`pnpm check-standalone` scans tracked file paths, file contents, and `package.json`. The term list is built by joining fragments, and the allow-list is empty. CI runs it.

CI runs on Node 22 with pnpm 10.33.3 under `LC_ALL` of `C.UTF-8`, `en_US.UTF-8`, `zh_CN.UTF-8`, and `sv_SE.UTF-8`, and logs `process.versions.icu` plus the resolved Intl locale.

The package builds to CommonJS with shipped `.d.ts` types. There is no dual ESM build.

## Publish

Tags must be `vX.Y.Z`. Any other tag, including prereleases, fails the workflow. Prereleases are not published under `--tag next`. The test job also runs `scripts/check-publish-tag.mjs` and fails unless the tag equals `v` plus the `package.json` version. The tagged commit must be an ancestor of `origin/main`, and the CI workflow must already have a successful run for that commit.

The publish workflow has two jobs. `test` has `contents: read` only and sets `LC_ALL=C.UTF-8` (present on GitHub ubuntu runners). The test step logs `echo $LC_ALL` and `locale` before `pnpm test`. `publish` needs `test`, uses the `npm-publish` environment, and has `contents: read`, `id-token: write`, and `actions: read` (the last is what lets the job read the CI run for this commit). The publish job does not run the test suite.

The publish job installs Node 22, then `npm install -g npm@^11.5.1` and logs `npm --version`. OIDC trusted publishing needs npm 11.5.1 or newer, and Node 22 bundles npm 10.x. It installs dependencies with `pnpm install --frozen-lockfile --ignore-scripts`, then builds. Publish uses `npm publish`, not `pnpm publish`.

`NPM_TOKEN` is read from the `npm-publish` environment (`environment: npm-publish` on the job). The owner moves the repository secret into that environment. The first-publish fallback is the only step that uses it, and it still emits `::warning::`.

If this version is already on the registry, the job compares the published `gitHead` to the tagged commit and the published `dist.integrity` to a local `npm pack`. A match skips publish. A mismatch fails.

If the package name is not on the registry yet, trusted publishing cannot be configured, so the job does not try OIDC. It logs that this is the first publish and emits `::warning::`, then publishes with `NPM_TOKEN`. That is the only fallback. A transient `npm view` error fails the job. After 0.1.0 is published, configure a trusted publisher on npm and remove the `NPM_TOKEN` step. Later versions, while the package exists, publish with OIDC only (`NODE_AUTH_TOKEN` unset).

Both publish commands pass `--provenance`. Provenance is a sigstore attestation signed with the workflow OIDC token. It is separate from registry login. The token path still requests that attestation.
