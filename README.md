# ffp-schema-doc

Build and parse schemaDoc (DDL text) from database introspection rows. Rows in, DDL string out.

This package is **0.x**. The schemaDoc text format is **not a stable contract**. Callers should pin a version and remeasure before changing it.

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

## Known limits

These behaviors are preserved from [ai-bi](https://github.com/ChuTingzj/ai-bi) at `fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2` and pinned by characterization tests in `test/known-limits.test.ts` (and the MySQL golden):

- PostgreSQL introspection SQL hardcodes schema `public`. The SQL is not shipped here; the frozen strings live under `test/reference/` and the tests assert the filter.
- Views are emitted as `CREATE TABLE`. `buildDdl` has no view syntax. `INFORMATION_SCHEMA.COLUMNS` returns views, and they become tables in schemaDoc.
- `parseSchemaDoc` takes the table name with `\w`, so CJK table names are dropped.
- The PostgreSQL foreign-key query filters `public` on the referencing table and does not qualify the referenced schema.
- Enum values are sorted with `localeCompare` and no locale argument, so the order depends on the runtime ICU default locale. On Node 22's full-ICU build that default stays `en-US` under both `C.UTF-8` and `en_US.UTF-8`. A different ICU data build can still reorder values such as `Ä` and CJK.

A later behavior fix is a minor version or above, and it needs an ai-bi remeasure before ai-bi adopts it.

The MySQL path only reads native `ENUM` column types. A `CHECK (col IN (...))` constraint is not turned into an enum comment. That is what `DataSourceService.extractMysqlSchema` does.

## Function bodies

`pnpm diff-bodies` diffs each moved function body against the committed ai-bi sources at `fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2` (`test/reference/ai-bi/`). Imports are stripped first. The diff must be empty. The script is offline; it does not fetch GitHub. CI runs it.

`buildPostgresSchemaDoc` and `buildMysqlSchemaDoc` are new. The script diffs their copied slices (row mapping, `mergeEnumMaps(native, check)`, the MySQL enum loop, and `tableCount`) against `datasource.service.ts`. The original `await this.fetch*` lines are the pure mapper calls (`buildNativeEnumMap`, `buildCheckEnumMap`, `mapPgForeignKeyRows`, `mapMysqlForeignKeyRows`) so the functions do not open a connection.

## Goldens

`test/golden/benchmark-postgres/` is db-captured from the ai-bi benchmark seed (`scripts/seed/`, same files and load order as `pnpm benchmark:db:seed`). `schema-doc.txt` is `buildDdl` with no foreign keys, matching `benchmark/scripts/setup.ts`. `schema-doc-with-fks.txt` includes foreign keys, matching `extractPostgresSchema`.

`test/golden/synthetic-mysql/` is db-captured from `scripts/sql/synthetic-mysql.sql`.

Each `metadata.json` records the SHA-256 of the six introspection SQL strings from `datasource.service.ts` at the pinned commit.

Regenerate locally (Postgres and MySQL on the machine, peer/socket auth, no credentials in the repo):

```bash
pnpm capture-golden
```

## Develop

```bash
pnpm install
pnpm test
pnpm diff-bodies
pnpm build
```

CI runs on Node 22 with pnpm 10.33.3, twice, under `LC_ALL=C.UTF-8` and `LC_ALL=en_US.UTF-8`, and logs `process.versions.icu`.

The package builds to CommonJS with shipped `.d.ts` types. There is no dual ESM build.
