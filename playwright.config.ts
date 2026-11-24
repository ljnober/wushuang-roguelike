import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 配置（ARCHITECTURE_FULLRUN.md §8.3 冻结要点）。
 * - testDir=./tests/e2e，timeout=180000，workers=1 / retries=0。
 * - project 隔离：fullrun 只跑 fullrun*.spec.ts；legacy 忽略它们，现有 7 项 E2E 不受影响。
 * - webServer 必须拉 vite dev（production build 无 /src/app/App.ts URL）。
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // CI 只跑这个 project；现有 7 项 E2E 保持原样不受影响
    { name: 'fullrun', testMatch: /fullrun.*\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'legacy', testIgnore: /fullrun.*\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
