# Cue — `src/db/migrations`

| Artifact | Role |
|----------|------|
| **`migrate.ts`** | Baseline `001` SQL, legacy idempotent upgrades, `_migrations` + Phase 4 programmatic step + numbered `*.sql` files. |
| **`001_initial_schema.sql`** | Phase 1–3 tables; not ledger-backed (replayed via `initSchema` only). |
| **`002_create_fundamental_cache.sql`** | `fundamentals_cache` (ledger id = basename without `.sql`). |

Add new DDL as `003_*.sql`, `004_*.sql`, …
