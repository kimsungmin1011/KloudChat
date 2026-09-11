import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const sessionId = 'phone-variant-fixture'
const now = '2026-09-12T00:00:00.000Z'
const question = '테스트 문장을 짧게 요약해 줘.'
const answer = '합성 UI 확인용 답변입니다.'

async function mockChat(page: Page) {
  const unexpected: string[] = []
  const allowedOrigin = new URL(String(test.info().project.use.baseURL)).origin
  page.on('pageerror', (error) => unexpected.push(`pageerror: ${error.message}`))
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === allowedOrigin) return route.continue()
    unexpected.push('Unexpected external request')
    return route.abort('blockedbyclient')
  })
  const row = {
    id: sessionId, title: '모바일 처리 내역', kind: 'chat', model: 'fixture/model',
    routingMode: 'manual', projectId: null, agentId: null, artifactId: null, pinned: false,
    messageCount: 2, createdAt: now, updatedAt: now,
    messages: [
      { id: 'fixture-user-message', role: 'user', content: question, attachments: [], createdAt: now },
      {
        id: 'fixture-answer', role: 'assistant', content: answer, attachments: [],
        model: 'fixture/model', createdAt: now,
        routing: {
          requestedModels: ['fixture/model'], routedModels: ['fixture/model'],
          effectiveModels: ['fixture/model'], actualModels: ['fixture/model'],
          actualModel: 'fixture/model', action: 'mask_external', dataBoundary: 'external',
        },
      },
    ],
  }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    const json = (value: unknown) => route.fulfill({ json: value })
    if (path === '/auth/refresh') return json({
      accessToken: 'fixture-only', expiresIn: 3600,
      user: {
        id: 'fixture-user', email: 'fixture@example.test', name: 'UI 검증',
        role: 'user', status: 'active', monthlyCredits: 1000, creditsUsed: 0,
        avatarColor: '#168267', allowedModels: [], createdAt: now,
        preferences: { autoMemory: false, showUsage: false, streamResponses: true },
      },
    })
    if (path === '/auth/config') return json({
      brand: { name: 'KloudChat', logo: '' }, enabledKinds: ['chat'],
      privacy: { externalDataGuard: false }, passwordResetEnabled: false, dictationEnabled: false,
    })
    if (path === '/models') return json({
      litellmAvailable: true, defaultChatModel: 'fixture/model',
      models: [{
        id: 'fixture/model', label: '검증 모델', name: '검증 모델', vendor: 'Fixture',
        provider: 'fixture', kinds: ['chat'], modality: 'chat', dataBoundary: 'external',
        strictLocal: false, privacyOnly: false, creditCost: 0, inputCreditCost: 0,
        supportsTools: true, supportsVision: false, contextWindow: 64000,
      }],
      autoRouting: { enabled: false, available: false, reason: null, economyModelIds: [] },
    })
    if (path === '/credits') return json({ monthlyCredits: 1000, creditsUsed: 0, creditsRemaining: 1000 })
    if (path === '/sessions' && request.method() === 'GET') return json([row])
    if (path === `/sessions/${sessionId}` && request.method() === 'GET') return json(row)
    if (path === `/sessions/${sessionId}/messages` && request.method() === 'GET') return json(row.messages)
    if (path === '/artifacts/counts') return json({ counts: {}, total: 0 })
    if (request.method() === 'GET' && [
      '/projects', '/artifacts', '/skills', '/memory', '/agents', '/tools', '/templates',
      '/connectors', '/connectors/catalog', '/jobs', '/designs', '/design-templates',
      '/prompt-templates', '/shares', `/sessions/${sessionId}/jobs`,
    ].includes(path)) return json([])
    unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 501, json: { detail: 'Unmocked fixture request' } })
  })
  return unexpected
}

for (const scenario of [
  { pointer: 'fine', width: 390, phone: true },
  { pointer: 'fine', width: 639, phone: true },
  { pointer: 'fine', width: 640, phone: true },
  { pointer: 'fine', width: 641, phone: false },
  { pointer: 'fine', width: 1440, phone: false },
  { pointer: 'coarse', width: 390, phone: true },
  { pointer: 'coarse', width: 768, phone: true },
  { pointer: 'coarse', width: 1024, phone: true },
  { pointer: 'coarse', width: 1025, phone: false },
]) {
  test(`${scenario.pointer}-${scenario.width}: phone utilities match the documented boundary`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      baseURL: String(testInfo.project.use.baseURL),
      viewport: { width: scenario.width, height: 900 },
      hasTouch: scenario.pointer === 'coarse',
      locale: 'ko-KR',
    })
    try {
      const page = await context.newPage()
      const unexpected = await mockChat(page)
      await page.goto(`/s/${sessionId}`)
      await expect(page.getByText(answer, { exact: true })).toBeVisible()
      const toggle = page.getByRole('button', { name: /^처리 내역/, includeHidden: true })
      const badgeList = toggle.locator('..').locator('div.flex.flex-wrap').first()
      const input = page.getByLabel('프롬프트 입력')
      const bubble = page.getByText(question, { exact: true })
      const computed = {
        ...(await page.evaluate(() => ({
          coarse: matchMedia('(pointer: coarse)').matches,
          phone: matchMedia('(pointer: coarse) and (max-width: 64rem), (max-width: 40rem)').matches,
          rootFontSize: getComputedStyle(document.documentElement).fontSize,
        }))),
        toggleDisplay: await toggle.evaluate((el) => getComputedStyle(el).display),
        badgeDisplay: await badgeList.evaluate((el) => getComputedStyle(el).display),
        inputFontSize: await input.evaluate((el) => getComputedStyle(el).fontSize),
        inputLineHeight: await input.evaluate((el) => getComputedStyle(el).lineHeight),
        bubbleFontSize: await bubble.evaluate((el) => getComputedStyle(el).fontSize),
      }
      const evidenceDir = process.env.PHONE_VARIANT_EVIDENCE_DIR
      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true })
        const name = `phone-${scenario.pointer}-${scenario.width}`
        await writeFile(join(evidenceDir, `${name}.json`), JSON.stringify(computed, null, 2))
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({ path: join(evidenceDir, `${name}.png`), animations: 'disabled' })
      }
      expect(computed.coarse).toBe(scenario.pointer === 'coarse')
      expect(computed.phone).toBe(scenario.phone)
      expect.soft(computed.toggleDisplay).toBe(scenario.phone ? 'inline-block' : 'none')
      expect.soft(computed.badgeDisplay).toBe(scenario.phone ? 'none' : 'flex')
      expect.soft(computed.rootFontSize).toBe(scenario.phone ? '22px' : '16px')
      expect.soft(computed.inputFontSize).toBe(scenario.phone ? '22px' : '15px')
      expect.soft(computed.inputLineHeight).toBe(scenario.phone ? '35.2px' : '24.375px')
      expect.soft(computed.bubbleFontSize).toBe(scenario.phone ? '22px' : '15px')
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      for (const control of [input, bubble]) {
        const bounds = await control.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(scenario.width)
      }
      if (scenario.phone && await toggle.isVisible()) {
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')
        await expect(badgeList).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
        await toggle.click()
        await expect(badgeList).toBeHidden()
      }
      expect(unexpected).toEqual([])
    } finally {
      await context.close()
    }
  })
}
