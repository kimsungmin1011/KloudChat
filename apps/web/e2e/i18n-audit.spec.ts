import { expect, test } from '@playwright/test'
import { auditEnglishMode } from './i18n-audit'

test('영어 모드에 남은 한글', async ({ page }) => {
  const findings = await auditEnglishMode(page)
  expect(findings, `${findings.length}건`).toEqual([])
})
