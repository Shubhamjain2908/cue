import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      POLYGON_API_KEY: "test_key",
      TELEGRAM_BOT_TOKEN: "test_bot_token",
      TELEGRAM_CHAT_ID: "test_chat_id",
      DB_PATH: ":memory:",
      LOCK_PATH: "/tmp/cue-test.lock",
      CACHE_DIR: "/tmp/cue-test-cache",
      LLM_PROVIDER: "mock",
    },
  },
});
