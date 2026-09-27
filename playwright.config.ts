import { defineConfig, devices } from '@playwright/test';

const tailnetWaitTimeout = 60_000;
const tailnetCleanupTimeout = 5_000;

export default defineConfig({
  testDir: './test/integration',
  testMatch: '**/*.spec.ts',
  timeout: tailnetWaitTimeout + tailnetCleanupTimeout + 25_000,
  use: { baseURL: 'http://127.0.0.1:4173' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && vite --config vite.integration.config.ts --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
