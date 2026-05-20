/**
 * Public DB entry — `./migrate.ts` re-exports the runner; SQL migrations live in `./migrations/`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  initSchema,
  migrateTracked,
  runDbInitFromConfig,
  type MigrateTrackedResult,
} from "./migrate.js";

export { initSchema, migrateTracked, runDbInitFromConfig, type MigrateTrackedResult };

const isMain =
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "");

if (isMain) {
  runDbInitFromConfig();
}
