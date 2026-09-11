import { expect, test, type Page, type TestInfo } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

const id = '11111111111111111111111111111111'
const otherId = '22222222222222222222222222222222'
const at = '2026-09-12T00:00:00.000Z'
type Kind = 'chat' | 'report' | 'slides'
const placeholders: Record<Kind, string> = {
  chat: '무엇이든 물어보세요',
  report: '보고서 주제와 넣고 싶은 절을 적으세요',
  slides: '발표 주제와 시간을 적으세요',
}
const prompt = '점검 결과 보고서를 작성해줘.'

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function fixture(page: Page, testInfo: TestInfo, kind: Kind, agent = false) {
  const origin = new URL(String(testInfo.project.use.baseURL)).origin
  expect(new URL(origin).hostname).toBe('127.0.0.1')
  const list = deferred()
  const detail = deferred()
  const agents = deferred()
  const otherDetail = deferred()
  const seenList = deferred()
  const seenDetail = deferred()
  const writes: { method: string; path: string; data: unknown }[] = []
  const unexpected: string[] = []
  let status = 200
  let detailCalls = 0
  let delayOther = false
  const row = {
    id, title: `Original ${kind}`, kind, model: 'fixture/model', routingMode: 'manual',
    projectId: null, agentId: agent ? 'fixture-agent' : null, artifactId: null, pinned: false,
    messages: [], messageCount: 0, made: null, createdAt: at, updatedAt: at,
  }
  let second = { ...row, id: otherId, title: 'Other slides', kind: 'slides' as Kind }
  let listing = [row]
  const user = {
    id: 'fixture-user', name: 'Hydration fixture', email: 'fixture@example.test', role: 'user',
    status: 'active', monthlyCredits: 1000, creditsUsed: 0, avatarColor: '#168267',
    allowedModels: [], createdAt: at,
    preferences: { autoMemory: false, showUsage: false, streamResponses: true },
  }
  await page.context().routeWebSocket('**/*', (socket) => { unexpected.push('WebSocket'); socket.close() })
  await page.context().route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) {
      unexpected.push(`external ${url.origin}`)
      return route.abort('blockedbyclient')
    }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const path = url.pathname.slice(4)
    const method = request.method()
    if (method === 'POST' && path === '/auth/refresh') {
      return route.fulfill({ json: { accessToken: 'fixture-only', expiresIn: 3600, user } })
    }
    if (method === 'GET' && path === '/auth/config') return route.fulfill({ json: {
      brand: { name: 'KloudChat', logo: '' }, enabledKinds: ['chat', 'report', 'slides'],
      privacy: { externalDataGuard: false }, passwordResetEnabled: false, dictationEnabled: false,
    } })
    if (method === 'GET' && path === '/models') return route.fulfill({ json: {
      models: ['fixture/model', 'fixture/agent'].map((modelId) => ({
        id: modelId, label: modelId === 'fixture/agent' ? 'Agent fixture' : 'Fixture',
        name: modelId === 'fixture/agent' ? 'Agent fixture' : 'Fixture', vendor: 'Fixture',
        provider: 'fixture', kinds: ['chat', 'report', 'slides'], modality: 'chat',
        dataBoundary: 'external', creditCost: 1, inputCreditCost: 1, supportsTools: true,
        contextWindow: 64000 })), defaultChatModel: 'fixture/model',
      defaults: { chat: 'fixture/model', report: 'fixture/model', slides: 'fixture/model' },
      litellmAvailable: false, autoRouting: { enabled: false, available: false },
    } })
    if (method === 'GET' && path === '/credits') return route.fulfill({ json: {
      monthlyCredits: 1000, creditsUsed: 0, creditsRemaining: 1000,
    } })
    if (method === 'GET' && path === '/sessions') {
      seenList.release()
      await list.promise
      return route.fulfill({ json: listing })
    }
    if (method === 'GET' && path === `/sessions/${id}`) {
      detailCalls += 1
      seenDetail.release()
      await detail.promise
      return route.fulfill(status === 200 ? { json: row } : { status, json: { detail: 'fixture_failure' } })
    }
    if (method === 'GET' && path === '/agents') {
      await agents.promise
      return route.fulfill({ json: agent ? [{ id: 'fixture-agent', ownerId: user.id,
        name: 'Original Agent', slug: 'original-agent', description: 'Fixture', model: 'fixture/agent',
        systemPrompt: '', tools: [], skillIds: [], kinds: ['chat', 'report', 'slides'], guide: '', starters: [],
        color: '#168267', enabled: true, visibility: 'private', installs: 0, runs: 0, updatedAt: at,
      }] : [] })
    }
    if (method === 'POST' && path === '/sessions') {
      writes.push({ method, path, data: request.postDataJSON() })
      second = { ...row, id: otherId, kind: request.postDataJSON().kind }
      return route.fulfill({ json: second })
    }
    if (method === 'POST' && /^\/sessions\/[^/]+\/messages$/.test(path)) {
      writes.push({ method, path, data: request.postDataJSON() })
      row.messageCount = 2
      return route.fulfill({ contentType: 'text/event-stream', body:
        'data: {"type":"delta","text":"Synthetic answer"}\n\n' +
        'data: {"type":"usage","inputTokens":1,"outputTokens":1,"credits":0}\n\n' +
        'data: {"type":"done"}\n\n' })
    }
    if (method === 'GET' && path === `/sessions/${otherId}`) {
      if (delayOther) await otherDetail.promise
      return route.fulfill({ json: second })
    }
    if (method === 'DELETE' && path.startsWith('/sessions/')) {
      writes.push({ method, path, data: null })
      return route.fulfill({ status: 204 })
    }
    if (method === 'GET' && path === '/artifacts/counts') return route.fulfill({ json: { counts: {}, total: 0 } })
    if (method === 'GET' && (path.endsWith('/jobs') || ['/projects', '/skills', '/memory', '/tools',
      '/templates', '/connectors', '/connectors/catalog', '/designs', '/design-templates',
      '/prompt-templates', '/shares', '/artifacts'].includes(path))) return route.fulfill({ json: [] })
    unexpected.push(`${method} ${path}`)
    return route.abort('blockedbyclient')
  })
  return {
    list, detail, agents, otherDetail, seenList, seenDetail, writes, unexpected,
    setStatus: (next: number) => { status = next },
    setSessionModel: (model: string) => { row.model = model },
    omitListing: () => { listing = [] },
    delayOther: () => { delayOther = true },
    detailCalls: () => detailCalls,
    release: () => { list.release(); detail.release(); agents.release(); otherDetail.release() },
  }
}

for (const kind of ['chat', 'report', 'slides'] as const) {
  for (const resolvesFirst of ['list', 'detail'] as const) {
    test(`${kind}: pending metadata blocks fast Enter until ${resolvesFirst} supplies the kind`, async ({ page }, info) => {
      const state = await fixture(page, info, kind)
      try {
        state.agents.release()
        await page.goto(`/s/${id}`)
        await state.seenList.promise
        await state.seenDetail.promise
        const composer = page.getByLabel('프롬프트 입력')
        if (await composer.isVisible()) {
          await composer.fill(prompt)
          await expect(page.getByRole('button', { name: '전송', exact: true })).toBeEnabled()
          await composer.press('Enter')
          await expect.poll(() => state.writes.length).toBeGreaterThan(0)
        }
        await page.screenshot({ path: info.outputPath('metadata-pending.png') })
        expect(state.writes).toEqual([])
        await expect(composer).toHaveCount(0)
        state[resolvesFirst].release()
        await expect(composer).toHaveAttribute('placeholder', placeholders[kind])
        const text = kind === 'chat' ? '두 문장으로 설명해줘.' : prompt
        await composer.fill(text)
        await composer.press('Enter')
        await expect.poll(() => state.writes.filter((write) => write.path.endsWith('/messages')).length).toBe(1)
        expect(state.writes).toEqual([{ method: 'POST', path: `/sessions/${id}/messages`, data: expect.objectContaining({ content: text }) }])
        expect(state.unexpected).toEqual([])
        await expect(page).toHaveURL(new RegExp(`/s/${id}$`))
      } finally {
        state.release()
      }
    })
  }
}

for (const status of [404, 503]) {
  test(`${status}: failed metadata stays unsendable and can be retried`, async ({ page }, info) => {
    const state = await fixture(page, info, 'report')
    try {
      state.setStatus(status)
      state.agents.release()
      state.detail.release()
      await page.goto(`/s/${id}`)
      await expect(page.getByText('최신 내용을 불러오지 못했습니다.', { exact: true })).toBeVisible()
      await expect(page.getByLabel('프롬프트 입력')).toHaveCount(0)
      expect(state.writes).toEqual([])
      await page.screenshot({ path: info.outputPath(`metadata-${status}.png`) })
      const before = state.detailCalls()
      state.setStatus(200)
      await page.getByRole('button', { name: '다시 시도', exact: true }).click()
      await expect(page.getByLabel('프롬프트 입력')).toHaveAttribute('placeholder', placeholders.report)
      expect(state.detailCalls()).toBeGreaterThan(before)
      await page.getByLabel('프롬프트 입력').fill(prompt)
      await page.getByLabel('프롬프트 입력').press('Enter')
      await expect.poll(() => state.writes.filter((write) => write.path.endsWith('/messages')).length).toBe(1)
      expect(state.writes).toEqual([{ method: 'POST', path: `/sessions/${id}/messages`, data: expect.objectContaining({ content: prompt }) }])
    } finally {
      state.release()
    }
  })
}

test('an Agent session keeps its identity while the Agent catalogue is delayed', async ({ page }, info) => {
  const state = await fixture(page, info, 'chat', true)
  try {
    state.list.release()
    state.detail.release()
    await page.goto(`/s/${id}`)
    const composer = page.getByLabel('프롬프트 입력')
    await expect(composer).toHaveAttribute('placeholder', placeholders.chat)
    await composer.fill(prompt)
    await composer.press('Enter')
    await expect.poll(() => state.writes.filter((write) => write.path.endsWith('/messages')).length).toBe(1)
    expect(state.writes).toEqual([{ method: 'POST', path: `/sessions/${id}/messages`, data: expect.objectContaining({ content: prompt }) }])
    await expect(page).toHaveURL(new RegExp(`/s/${id}$`))
    expect(state.unexpected).toEqual([])
  } finally {
    state.release()
  }
})

test('a ready non-Agent chat still hands an explicit document request to report', async ({ page }, info) => {
  const state = await fixture(page, info, 'chat')
  try {
    state.release()
    await page.goto(`/s/${id}`)
    const composer = page.getByLabel('프롬프트 입력')
    await expect(composer).toHaveAttribute('placeholder', placeholders.chat)
    await composer.fill(prompt)
    await composer.press('Enter')
    await expect.poll(() => state.writes.filter((write) => write.path.endsWith('/messages')).length).toBe(1)
    expect(state.writes.filter((write) => write.method === 'POST')).toEqual([
      { method: 'POST', path: '/sessions', data: expect.objectContaining({ kind: 'report' }) },
      { method: 'POST', path: `/sessions/${otherId}/messages`, data: expect.objectContaining({ content: prompt }) },
    ])
    await expect(page).toHaveURL(new RegExp(`/s/${otherId}$`))
    expect(state.unexpected).toEqual([])
  } finally {
    state.release()
  }
})

for (const kind of ['chat', 'report', 'slides'] as const) {
  for (const selection of ['pending inheritance', 'loaded inheritance', 'explicit override'] as const) {
    test(`${kind}: Agent model preserves ${selection}`, async ({ page }, info) => {
      const state = await fixture(page, info, kind, true)
      try {
        state.setSessionModel(selection === 'explicit override' ? 'fixture/model' : '')
        state.list.release()
        state.detail.release()
        if (selection === 'loaded inheritance') state.agents.release()
        await page.goto(`/s/${id}`)
        const composer = page.getByLabel('프롬프트 입력')
        await expect(composer).toHaveAttribute('placeholder', placeholders[kind])
        if (selection === 'loaded inheritance') {
          await expect(page.getByRole('button', { name: /Agent fixture/ }).first()).toBeVisible()
        }
        await composer.fill(prompt)
        await composer.press('Enter')
        await expect.poll(() => state.writes.length).toBe(1)
        expect(state.writes[0]).toMatchObject({ method: 'POST', path: `/sessions/${id}/messages` })
        const payload = state.writes[0].data as { model?: string }
        // Chat resolves the saved model server-side; document requests carry their choice.
        if (kind === 'chat') {
          expect(payload.model).toBeUndefined()
        } else if (selection === 'pending inheritance') {
          expect(payload.model).toBe('')
        } else {
          expect(payload.model).toBe(selection === 'loaded inheritance' ? 'fixture/agent' : 'fixture/model')
        }
        expect(state.unexpected).toEqual([])
      } finally {
        state.release()
      }
    })
  }
}

for (const delayed of [false, true]) {
  test(`a late failure for A does not replace B's ${delayed ? 'pending' : 'loaded'} state`, async ({ page }, info) => {
    const state = await fixture(page, info, 'report')
    try {
      state.setStatus(503)
      state.omitListing()
      state.list.release()
      state.agents.release()
      if (delayed) state.delayOther()
      await page.goto(`/s/${id}`)
      await state.seenDetail.promise
      await expect(page.getByRole('status').filter({ hasText: '불러오는 중…' })).toBeVisible()
      await page.evaluate((target) => {
        window.history.pushState(null, '', target)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }, `/s/${otherId}`)
      if (delayed) {
        await expect(page.getByLabel('프롬프트 입력')).toHaveCount(0)
      } else {
        await expect(page.getByLabel('프롬프트 입력')).toHaveAttribute('placeholder', placeholders.slides)
      }
      const failedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sessions/${id}`)
      state.detail.release()
      await failedResponse
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      await expect(page.getByRole('alert')).toHaveCount(0)
      if (delayed) {
        await expect(page.getByRole('status').filter({ hasText: '불러오는 중…' })).toBeVisible()
        state.otherDetail.release()
      }
      await expect(page.getByLabel('프롬프트 입력')).toHaveAttribute('placeholder', placeholders.slides)
      await expect(page).toHaveURL(new RegExp(`/s/${otherId}$`))
      expect(state.writes).toEqual([])
      expect(state.unexpected).toEqual([])
    } finally {
      state.release()
    }
  })
}

for (const kind of ['chat', 'report', 'slides'] as const) {
  test(`a new ${kind} surface still creates its intended session`, async ({ page }, info) => {
    const state = await fixture(page, info, kind)
    try {
      state.release()
      await page.goto(`/new/${kind}`)
      const composer = page.getByLabel('프롬프트 입력')
      await expect(composer).toHaveAttribute('placeholder', placeholders[kind])
      const content = kind === 'chat' ? '두 문장으로 설명해줘.' : prompt
      await composer.fill(content)
      await composer.press('Enter')
      await expect.poll(() => state.writes.filter((write) => write.path.endsWith('/messages')).length).toBe(1)
      expect(state.writes).toEqual([
        { method: 'POST', path: '/sessions', data: expect.objectContaining({ kind }) },
        { method: 'POST', path: `/sessions/${otherId}/messages`, data: expect.objectContaining({ content }) },
      ])
      expect(state.unexpected).toEqual([])
    } finally {
      state.release()
    }
  })
}
