import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testMatch: 'phone-variant.spec.ts',
  reporter: process.env.CI ? 'github' : 'list',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5191', trace: 'off' },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 5191 --strictPort',
    env: { API_BASE_URL: 'http://127.0.0.1:59999' },
    url: 'http://127.0.0.1:5191',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: 'phone', use: { browserName: 'chromium' } }],
})
