import { defineConfig, devices } from "@playwright/test";

// The browser walkthrough against a running app on localnet. e2e/run-localnet.sh seeds the validator,
// builds and starts the app and sets E2E_BASE_URL and PREORDER_ROOT for these tests.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 60_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3301",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1360, height: 900 },
  },
});
