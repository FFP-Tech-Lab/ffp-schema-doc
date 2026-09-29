Frozen reference snapshot of the original implementation, commit `fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2`. Offline input to `pnpm diff-bodies`. No remote is fetched.

Files under `test/reference/fa3cbe7/`:

- `schema-enum.ts`
- `schema-parse.ts`
- `guidance-types.ts`
- `schema-fk.ts`
- `datasource.service.ts` (introspection SQL lives here; it is not shipped in the package)

`schema-fk.ts` imports `SchemaForeignKeyRow` from `./schema-enum`. `pnpm diff-bodies` normalizes every import specifier before the whole-file compare, so that relative specifier is not part of the equality bytes.

`datasource.service.ts` is not compared as a whole file. Two package import specifiers in that file were rewritten to the neutral module names `datasource-db` and `schema-doc-shared`. The compared ranges are lines 230–245 and 341–369, which do not include those imports. The query text is unchanged.
