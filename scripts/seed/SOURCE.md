The SQL files in this directory are the ai-bi benchmark seed, copied verbatim so golden capture can recreate that database without cloning ai-bi.

- Source: https://github.com/ChuTingzj/ai-bi
- Commit: `fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2`
- Paths: `benchmark/seed/01-schema.sql`, `benchmark/seed/02-data.sql`
- Load order matches `pnpm benchmark:db:seed` (schema, then data)

The rows are synthetic ecommerce data from that benchmark. They are not customer data.
