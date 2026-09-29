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

These behaviors are pinned by characterization tests in `test/known-limits.test.ts` and by the synthetic goldens. The implementation matches the frozen reference snapshot at commit `fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2`.

- PostgreSQL introspection SQL hardcodes schema `public`. The SQL is not shipped here; the frozen strings live under `test/reference/` and the tests assert the filter.
- Views are emitted as `CREATE TABLE`. `buildDdl` has no view syntax. `INFORMATION_SCHEMA.COLUMNS` returns views, and they become tables in schemaDoc.
- `parseSchemaDoc` takes the table name with `\w`, so CJK table names are dropped.
- The PostgreSQL foreign-key query filters `public` on the referencing table and does not qualify the referenced schema.
- Enum values are sorted with `localeCompare` and no locale argument. The order is the Node Intl default locale, which follows `LC_ALL` even when that OS locale is not installed. Measured on Node 22.14.0 (ICU 76.1): `C.UTF-8` and `en_US.UTF-8` both resolve to `en-US` (`Ä` before `z`, CJK after Latin); `zh_CN.UTF-8` resolves to `zh-CN` (CJK first); `sv_SE.UTF-8` resolves to `sv-SE` (`Ä` after `z`). `C.UTF-8` and `en_US.UTF-8` do not differ from each other.
- A varchar CHECK is not an enum comment. PostgreSQL 16 prints `CHECK (((status_code)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))`. `parsePgCheckEnum` returns null for that text. Only `= ANY (ARRAY['a'::text, ...])` matches, which is what a `text` column's CHECK prints. The synthetic Postgres golden captures both forms.
- An enum value that contains a comma is truncated on parse. `buildDdl` emits `-- enum: (z) | w | x,y,` and `parseSchemaDoc` keeps `(z)`, `w`, and `x`.

Output-changing fixes are released as a minor version or higher and called out in the changelog so consumers can re-validate.

The MySQL path only reads native `ENUM` column types. A `CHECK (col IN (...))` constraint is not turned into an enum comment.

## Function bodies

`pnpm diff-bodies` compares `schema-enum.ts`, `schema-parse.ts`, and `schema-fk.ts` to the frozen reference snapshot of the original implementation at commit `fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2` (`test/reference/fa3cbe7/`) as whole files. Import specifiers are normalized (`from '...'` becomes `from 'NORMALIZED'`); every other byte must match, including `MAX_ENUM_VALUES`, types, and regexes. The script is offline.

`buildPostgresSchemaDoc` and `buildMysqlSchemaDoc` are new. The script compares each function body to an explicit line range of the frozen `datasource.service.ts` (lines 230–245 and 341–369). The only normalization is dedent, plus replacing `await this.fetchPostgresNativeEnums(client, rows)`, `await this.fetchPostgresCheckEnums(client)`, `await this.fetchPostgresForeignKeys(client)`, and `await this.fetchMysqlForeignKeys(conn, ds.database)` with `buildNativeEnumMap(rows, nativeEnumRows)`, `buildCheckEnumMap(checkRows)`, `mapPgForeignKeyRows(foreignKeyRows)`, and `mapMysqlForeignKeyRows(foreignKeyRows)`. Any other difference fails.

`pnpm diff-bodies:prove` checks that changing `MAX_ENUM_VALUES` from 50 to 51 fails that compare, without writing the edit. CI runs both commands. `test/known-limits.test.ts` also pins the constant at 50 and the drop of the 51st sorted value.

## Goldens

`test/golden/sample-postgres/` is db-captured from the sample schema (`scripts/seed/`, schema then data) loaded into the disposable database `ffp_schema_doc_capture`. That schema has no native enum and no CHECK constraint. `schema-doc.txt` is `buildDdl` with no foreign keys. `schema-doc-with-fks.txt` includes foreign keys.

`test/golden/synthetic-postgres/` is db-captured from `scripts/sql/synthetic-postgres.sql` into `ffp_schema_doc_capture_pg` (native enum, text CHECK enum, varchar CHECK enum, composite foreign key, view, mixed-case names, CJK table name, CJK enum values). Its `schema-doc.txt` is produced by `scripts/fa3cbe7-postgres-schema-doc.ts`, which calls the committed fa3cbe7 reference copies the way `extractPostgresSchema` does. It does not call `buildPostgresSchemaDoc`. The enum comment order in that file is the capture locale (`en-US`). Tests compare the package to the fa3cbe7 composer in the current process, and compare both to the frozen file when `localeCompare` still produces that captured order.

`test/golden/synthetic-mysql/` is db-captured from `scripts/sql/synthetic-mysql.sql` into `ffp_schema_doc_capture_mysql`.

Postgres rows are `psql` `json_agg` output. MySQL rows are `JSON_OBJECT` output. They are not `pg` or `mysql2` driver values, so driver coercions (`ordinal_position` as a string or BigInt, `Buffer`) are not in the goldens. `Number(r.ordinal_position) || 1` can hide those coercions. Callers that run their own SQL should hash it, or integration-test it, against the exported row types.

Each `metadata.json` records the SHA-256 of the six introspection SQL strings from `datasource.service.ts` at the pinned commit. `scripts/capture-golden.ts` will only `DROP` a database named `ffp_schema_doc_capture`, `ffp_schema_doc_capture_pg`, or `ffp_schema_doc_capture_mysql`.

Regenerate locally (Postgres and MySQL on the machine, peer/socket auth, no credentials in the repo):

```bash
pnpm capture-golden
```

## Develop

```bash
pnpm install
pnpm test
pnpm diff-bodies
pnpm diff-bodies:prove
pnpm check-standalone
pnpm build
```

`pnpm check-standalone` scans tracked file paths, file contents, and `package.json`. The term list is built by joining fragments, and the allow-list is empty. CI runs it.

CI runs on Node 22 with pnpm 10.33.3 under `LC_ALL` of `C.UTF-8`, `en_US.UTF-8`, `zh_CN.UTF-8`, and `sv_SE.UTF-8`, and logs `process.versions.icu` plus the resolved Intl locale.

The package builds to CommonJS with shipped `.d.ts` types. There is no dual ESM build.

## Publish

Tags must be `vX.Y.Z`. Any other tag, including prereleases, fails the workflow. Prereleases are not published under `--tag next`. The tagged commit must be an ancestor of `origin/main`, and the CI workflow must already have a successful run for that commit.

The publish workflow has two jobs. `test` has `contents: read` only. `publish` needs `test`, uses the `npm-publish` environment, and has `contents: read`, `id-token: write`, and `actions: read` (the last is what lets the job read the CI run for this commit).

The publish job installs Node 22 and runs that Node's bundled `npm` (`npm publish`, not `pnpm publish`).

If this version is already on the registry, the job compares the published `gitHead` to the tagged commit and the published `dist.integrity` to a local `npm pack`. A match skips publish. A mismatch fails.

If the package name is not on the registry yet, trusted publishing cannot be configured, so the job does not try OIDC. It logs that this is the first publish and emits `::warning::`, then publishes with `NPM_TOKEN`. That is the only fallback. A transient `npm view` error fails the job. After 0.1.0 is published, configure a trusted publisher on npm and remove the `NPM_TOKEN` step. Later versions, while the package exists, publish with OIDC only (`NODE_AUTH_TOKEN` unset).

Both publish commands pass `--provenance`. Provenance is a sigstore attestation signed with the workflow OIDC token. It is separate from registry login. The token path still requests that attestation.
