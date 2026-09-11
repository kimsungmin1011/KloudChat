import { expect, test, type Page } from '@playwright/test'

const sessionId = 'freshness-fixture'
const now = '2026-09-12T00:00:00.000Z'
const prompt = '현재 대한민국 대통령이 누구야?'
const answer = '최신 정보를 확인할 수 없어 답변을 보류합니다. 확인 가능한 자료를 제공해 주세요.'
const badgeText = '서비스 정책 안내 · 최신 정보 검증 불가 · 모델 실행 없음'
const refusal = '최신 정보를 검증할 수 없어 요청을 진행하지 않았습니다. 검증 가능한 자료를 제공하거나 검색이 허용된 환경에서 다시 시도하세요.'
const englishRefusal = 'The request was not run because current information could not be verified. Provide verifiable sources or retry in an environment where search is permitted.'
type Reason = 'verification_unavailable' | 'lookup_failed_or_empty'
type Surface = 'chat' | 'report' | 'slides' | 'compare'

/** All API requests remain in the fixture; unknown requests fail locally. */
async function mockFreshness(page: Page, options: { saved?: boolean; reason?: Reason; surface?: Surface; handoff?: boolean } = {}) {
  const requests: { path: string; body: Record<string, unknown> }[] = []
  const emptySessionRemovals: string[] = []
  const unexpected: string[] = []
  page.on('pageerror', (error) => unexpected.push(`pageerror: ${error.message}`))
  const routing = {
    answerOrigin: 'server_policy', actualModel: null,
    freshness: { status: 'unverified', reason: options.reason ?? 'verification_unavailable' },
  }
  const messages = [
    { id: 'fixture-question', role: 'user', content: prompt, attachments: [], routing, createdAt: now },
    {
      id: 'fixture-answer', role: 'assistant', content: answer, attachments: [],
      model: null, routing, usage: { inputTokens: 0, outputTokens: 0, credits: 0 },
      artifactIds: null, failure: null, createdAt: now,
    },
  ]
  const kind = options.handoff || options.surface === 'compare' ? 'chat' : options.surface ?? 'chat'
  const row = {
    id: sessionId, title: '최신 정보 확인', kind, model: 'fixture/qwen',
    routingMode: 'manual', projectId: null, agentId: null, artifactId: null, pinned: false,
    messages: options.saved ? messages : [], messageCount: options.saved ? 2 : 0,
    createdAt: now, updatedAt: now,
  }
  const handoffId = `${sessionId}-handoff`
  let handoffRow: typeof row | null = null
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    const json = (value: unknown) => route.fulfill({ json: value })
    if (path === '/auth/refresh') return json({
      accessToken: 'fixture-only', expiresIn: 3600,
      user: {
        id: 'fixture-user', email: 'fixture@example.com', name: '최신 정보 검증',
        role: 'user', status: 'active', monthlyCredits: 1000, creditsUsed: 0,
        avatarColor: '#168267', allowedModels: [], createdAt: now,
        preferences: { autoMemory: false, showUsage: true, streamResponses: true },
      },
    })
    if (path === '/auth/config') return json({
      brand: { name: 'KloudChat', logo: '' }, enabledKinds: ['chat', 'report', 'slides'],
      privacy: { externalDataGuard: false }, passwordResetEnabled: false, dictationEnabled: false,
    })
    if (path === '/models') return json({
      litellmAvailable: true, defaultChatModel: 'fixture/qwen',
      models: ['qwen', 'second'].map((id) => ({
        id: `fixture/${id}`, label: id === 'qwen' ? 'Qwen 검증 모델' : '비교 검증 모델',
        name: id, vendor: 'Fixture', provider: 'fixture', kinds: ['chat', 'report', 'slides'],
        modality: 'chat', dataBoundary: 'self_hosted', strictLocal: true, privacyOnly: false,
        creditCost: 0, inputCreditCost: 0, supportsTools: true, supportsVision: false, contextWindow: 64000,
      })),
    })
    if (path === '/credits') return json({ monthlyCredits: 1000, creditsUsed: 0, creditsRemaining: 1000 })
    if (path === '/sessions') {
      if (request.method() === 'GET') return json(handoffRow ? [handoffRow, ...(emptySessionRemovals.length ? [] : [row])] : [row])
      if (request.method() === 'POST' && options.handoff) {
        handoffRow = { ...row, id: handoffId, kind: request.postDataJSON().kind }
        return json(handoffRow)
      }
    }
    if (options.handoff && path === `/sessions/${sessionId}` && request.method() === 'DELETE') {
      emptySessionRemovals.push(sessionId)
      return route.fulfill({ status: 204 })
    }
    if (path === `/sessions/${sessionId}` && request.method() === 'GET') return json(row)
    if (path === `/sessions/${handoffId}` && request.method() === 'GET') return json(handoffRow)
    if ([`/sessions/${sessionId}/messages`, `/sessions/${sessionId}/compare`, `/sessions/${handoffId}/messages`].includes(path)) {
      if (request.method() === 'GET') return json(row.messages)
      if (request.method() === 'POST') {
        requests.push({ path, body: request.postDataJSON() })
        if (options.surface && options.surface !== 'chat') {
          return route.fulfill({ status: 409, json: { detail: 'freshness_verification_unavailable' } })
        }
        row.messages = messages
        row.messageCount = 2
        return route.fulfill({
          status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
          body: [
            ...(options.reason === 'lookup_failed_or_empty' ? [{
              type: 'model_route', mode: 'auto', decision: 'bypassed', reasonCode: 'unsupported_turn',
              requestedModel: 'fixture/qwen', selectedModel: 'fixture/qwen',
              classifierVersion: 'adaptive-router-v1',
            }] : []),
            { type: 'freshness_abstention', ...routing },
            { type: 'delta', text: answer },
            { type: 'usage', inputTokens: 0, outputTokens: 0, credits: 0 },
            { type: 'done', messageId: 'fixture-answer' },
          ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        })
      }
    }
    if (path === '/artifacts/counts') return json({ counts: {}, total: 0 })
    if (request.method() === 'GET' && [
      '/projects', '/artifacts', '/skills', '/memory', '/agents', '/tools', '/templates',
      '/connectors', '/connectors/catalog', '/jobs', '/designs', '/design-templates',
      '/prompt-templates', '/shares', `/sessions/${sessionId}/jobs`, `/sessions/${handoffId}/jobs`,
    ].includes(path)) return json([])
    unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({ status: 501, json: { detail: 'Unmocked fixture request' } })
  })
  return { requests, unexpected, emptySessionRemovals }
}

async function expectReadable(page: Page, text: string) {
  const message = page.getByText(text, { exact: true })
  await expect(message).toBeVisible()
  await expect(message).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  const box = await message.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
}

async function screenshot(page: Page, filename: string) {
  if (!process.env.FRESHNESS_SCREENSHOT_DIR) return
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: `${process.env.FRESHNESS_SCREENSHOT_DIR}/${filename}.png`, animations: 'disabled' })
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  for (const mode of ['saved', 'streamed'] as const) {
    for (const reason of ['verification_unavailable', 'lookup_failed_or_empty'] as const) {
      test(`${viewport.name} ${mode} ${reason}: 서버 정책 응답에 모델 실행과 과금이 없음을 표시한다`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        const state = await mockFreshness(page, { saved: mode === 'saved', reason })
        await page.goto(`/s/${sessionId}`)
        if (mode === 'streamed') {
          const input = page.getByLabel('프롬프트 입력')
          await input.fill(prompt)
          await input.press('Enter')
        }
        await expect(page.getByText(answer, { exact: true })).toBeVisible()
        await expectReadable(page, badgeText)
        await expect(page.getByText('모델 실행 없음 · 0 in · 0 out · 0 크레딧', { exact: true })).toBeVisible()
        await expect(page.getByText(/Qwen 검증 모델 · 0 in/)).toHaveCount(0)
        await expect(page.getByText('확인 중…', { exact: true })).toHaveCount(0)
        await expect(page.getByText('무료', { exact: true })).toHaveCount(0)
        await expect(page.getByText('확인 후 외부 원문 전송', { exact: true })).toHaveCount(0)
        await screenshot(page, `freshness-${mode}-${reason}-${viewport.name}`)
        if (mode === 'streamed') {
          await page.reload()
          await expectReadable(page, badgeText)
          await expect(page.getByText('모델 실행 없음 · 0 in · 0 out · 0 크레딧', { exact: true })).toBeVisible()
        }
        await page.getByRole('button', { name: '언어 전환 · EN', exact: true }).click()
        await expectReadable(page, 'Service policy notice · Current information unverified · No model execution')
        expect(state.requests.map((request) => request.body.content)).toEqual(mode === 'saved' ? [] : [prompt])
        expect(state.unexpected).toEqual([])
      })
    }
  }
  for (const surface of ['report', 'slides', 'compare'] as const) {
    test(`${viewport.name} ${surface}: 최신 정보 검증 거부는 복구 방법과 초안을 보존한다`, async ({ page }) => {
      test.skip(viewport.name === 'mobile' && surface === 'compare', '모델 비교 전환 버튼은 데스크톱에서만 제공됨')
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      const state = await mockFreshness(page, { surface })
      await page.goto(`/s/${sessionId}`)
      if (surface === 'compare') {
        await page.getByRole('button', { name: '모델 비교', exact: true }).click()
        await page.getByRole('menuitem').filter({ hasText: '비교 모드' }).click()
      }
      const input = page.getByLabel('프롬프트 입력')
      await input.fill(prompt)
      await input.press('Enter')
      await expectReadable(page, refusal)
      await expect(input).toHaveValue(prompt)
      await expect(input).toBeEnabled()
      await expect(page.getByText(/freshness_verification_unavailable/)).toHaveCount(0)
      await screenshot(page, `freshness-refusal-${surface}-${viewport.name}`)
      await page.getByRole('button', { name: '언어 전환 · EN', exact: true }).click()
      const englishInput = page.getByLabel('Prompt', { exact: true })
      await englishInput.press('Enter')
      await expect(page.getByText(englishRefusal, { exact: true })).toBeVisible()
      expect(state.requests).toHaveLength(2)
      expect(state.requests[0].path).toBe(`/sessions/${sessionId}/${surface === 'compare' ? 'compare' : 'messages'}`)
      expect(state.unexpected).toEqual([])
    })
  }
  for (const surface of ['report', 'slides'] as const) {
    test(`${viewport.name} chat-to-${surface}: 화면 이동 후에도 최신 정보 거부와 초안을 보존한다`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      const state = await mockFreshness(page, { surface, handoff: true })
      await page.goto(`/s/${sessionId}`)
      const request = surface === 'report'
        ? '현재 대한민국 대통령 관련 보고서를 작성해 줘.'
        : '현재 대한민국 대통령 관련 발표 슬라이드를 만들어 줘.'
      const input = page.getByLabel('프롬프트 입력')
      await input.fill(request)
      await input.press('Enter')
      await expect(page).toHaveURL(new RegExp(`/s/${sessionId}-handoff$`))
      await expectReadable(page, refusal)
      await expect(page.getByLabel('프롬프트 입력')).toHaveValue(request)
      expect(state.requests).toHaveLength(1)
      expect(state.requests[0].path).toBe(`/sessions/${sessionId}-handoff/messages`)
      expect(state.emptySessionRemovals).toEqual([sessionId])
      expect(state.unexpected).toEqual([])
    })
  }
}
