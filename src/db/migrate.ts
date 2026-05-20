/**
 * Re-export migration runner for callers that expect `src/db/migrate.ts`.
 * Canonical implementation and SQL live in `./migrations/`.
 */
export {
  initSchema,
  migrateTracked,
  runDbInitFromConfig,
  type MigrateTrackedResult,
} from "./migrations/migrate.js";
