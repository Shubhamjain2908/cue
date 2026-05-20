/**
 * Public DB entry — implementation in `./migrations/migrate.ts` (+ `*.sql` alongside it).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  initSchema,
  migrateTracked,
  runDbInitFromConfig,
  type MigrateTrackedResult,
} from "./migrations/migrate.js";

export { initSchema, migrateTracked, runDbInitFromConfig, type MigrateTrackedResult };

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "");

if (isMain) {
  runDbInitFromConfig();
}
