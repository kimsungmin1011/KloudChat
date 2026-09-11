import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testMatch: ['auto-routing.spec.ts'],
  grep: /라우팅 기준에 따라|품질 라우팅 결과는 영어|품질 상향 응답은|처리 내역의 전체 모델 정보/,
  reporter: process.env.CI ? 'github' : 'list',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5194' },
  webServer: {
    ...base.webServer,
    command: 'npm run dev -- --host 127.0.0.1 --port 5194 --strictPort',
    url: 'http://127.0.0.1:5194',
    env: { API_BASE_URL: 'http://127.0.0.1:59999' },
    reuseExistingServer: false,
  },
  projects: base.projects!.filter((project) => ['desktop', 'laptop'].includes(project.name!)),
})
