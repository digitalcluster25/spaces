import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "npm run preview -- --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
    },
    ...(process.env.LOCAL_SUPABASE_URL && process.env.LOCAL_SUPABASE_SERVICE_KEY ? [{
      command: "node infrastructure/data-plane/server.js",
      url: "http://127.0.0.1:4300/health",
      reuseExistingServer: !process.env.CI,
      env: {
        SUPABASE_URL: process.env.LOCAL_SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_KEY,
        SPACES_DATA_ENCRYPTION_KEY: "b".repeat(64),
        DATA_PLANE_INTERNAL_SECRET: "playwright-internal-secret",
        PORT: "4300",
      },
    }, {
      command: "node infrastructure/billing/server.js",
      url: "http://127.0.0.1:4301/health",
      reuseExistingServer: !process.env.CI,
      env: {
        SUPABASE_URL: process.env.LOCAL_SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.LOCAL_SUPABASE_SERVICE_KEY,
        CREEM_API_KEY: "playwright-test-key",
        CREEM_WEBHOOK_SECRET: "playwright-webhook-secret",
        CREEM_MODE: "test",
        PORT: "4301",
      },
    }] : []),
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
