import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testMatch: /i18n-audit-gates\.spec\.ts/,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5193', trace: 'off', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 5193 --strictPort',
    env: { API_BASE_URL: 'http://127.0.0.1:59999' },
    url: 'http://127.0.0.1:5193',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
