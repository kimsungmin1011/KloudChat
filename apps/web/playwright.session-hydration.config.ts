import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testMatch: 'session-hydration.spec.ts',
  retries: 0,
  reporter: 'list',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5303', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 5303 --strictPort',
    env: { API_BASE_URL: 'http://127.0.0.1:59999' },
    url: 'http://127.0.0.1:5303',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
})
