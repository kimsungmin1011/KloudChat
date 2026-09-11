import { expect, test, type Page } from '@playwright/test'
import type { CostRouting, RoutingMode } from '../src/types'

const now = '2026-08-18T00:00:00.000Z'
const sessionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const screenshotDir = process.env.AUTO_ROUTING_SCREENSHOT_DIR

async function captureAutoRouting(page: Page, filename: string) {
  if (!screenshotDir) return
  await page.screenshot({
    path: `${screenshotDir}/${test.info().project.name}-${filename}`,
    animations: 'disabled',
  })
}

async function disableWebSearch(page: Page) {
  await page.getByRole('button', { name: '웹 검색: 자동', exact: true }).click()
  await page.getByRole('button', { name: '웹 검색: 켬', exact: true }).click()
  await expect(page.getByRole('button', { name: '웹 검색: 끔', exact: true })).toBeVisible()
}

async function openRoutingDetails(page: Page) {
  if ((page.viewportSize()?.width ?? 1440) >= 640) return
  await page.getByRole('button', { name: /처리 내역 \d+건/ }).click()
}

const model = (
  id: string,
  label: string,
  options: {
    boundary?: 'self_hosted' | 'external'
    strictLocal?: boolean
    privacyOnly?: boolean
    input?: number
    output?: number
  } = {},
) => ({
  id,
  label,
  name: label,
  vendor: 'Mock',
  provider: options.boundary === 'self_hosted' ? 'hosted_vllm' : 'openrouter',
  dataBoundary: options.boundary ?? 'external',
  strictLocal: options.strictLocal ?? false,
  privacyOnly: options.privacyOnly ?? false,
  modality: 'chat',
  kinds: ['chat'],
  creditCost: options.output ?? 1,
  inputCreditCost: options.input ?? 1,
  contextWindow: 64_000,
  supportsVision: false,
  supportsTools: true,
  description: `${label} description`,
})

const models = [
  model('external/premium', 'Mock · Premium', { input: 12, output: 30 }),
  model('external/economy-a', 'Mock · Economy A', { input: 1, output: 2 }),
  model('external/economy-b', 'Mock · Economy B', { input: 2, output: 3 }),
  model('external/quality', 'Mock · Quality', { input: 5, output: 10 }),
  model('strict-local/classifier', 'Mock · Strict Classifier', {
    boundary: 'self_hosted',
    strictLocal: true,
    privacyOnly: true,
    input: 0,
    output: 0,
  }),
]

type MockState = {
  sessions: Record<string, unknown>[]
  creates: Record<string, unknown>[]
  patches: Record<string, unknown>[]
  messageRequests: Record<string, unknown>[]
  governancePuts: Record<string, unknown>[]
  failGovernance: boolean
}

async function mockApp(
  page: Page,
  initialRoutingMode: RoutingMode = 'manual',
  routeDecision: CostRouting['decision'] = 'routed',
  reasonCode?: string,
) {
  // Every API call stays in this fixture, including unknown endpoints.
  await page.route('**/api/**', (route) => route.abort('blockedbyclient'))
  const state: MockState = {
    sessions: [],
    creates: [],
    patches: [],
    messageRequests: [],
    governancePuts: [],
    failGovernance: false,
  }
  let governance = {
    piiMasking: false,
    externalDataGuard: false,
    allowUserRawExternal: false,
    privacySafeModelIds: [],
    intentFilter: false,
    blockedCategories: [],
    retentionDays: 0,
    adaptiveRoutingEnabled: false,
    adaptiveClassifierModelId: null as string | null,
    adaptiveEconomyModelIds: [] as string[],
  }

  await page.route(/\/api\/auth\/refresh$/, (route) =>
    route.fulfill({
      json: {
        accessToken: 'mock-access-token',
        expiresIn: 3_600,
        user: {
          id: 'user-1',
          email: 'auto@example.com',
          name: 'Auto 검증',
          role: 'admin',
          status: 'active',
          monthlyCredits: 10_000,
          creditsUsed: 0,
          cycleResetsAt: null,
          avatarColor: '#64748b',
          litellmKeyPreview: null,
          litellmKeyIssuedAt: null,
          preferences: {
            streamResponses: true,
            autoMemory: false,
            showUsage: false,
            privacyDefaultAction: 'ask',
          },
          allowedModels: [],
          createdAt: now,
          lastActiveAt: now,
        },
      },
    }),
  )
  await page.route(/\/api\/auth\/config$/, (route) =>
    route.fulfill({
      json: {
        passwordResetEnabled: false,
        dictationEnabled: false,
        brand: { name: 'KloudChat', logo: '' },
        enabledKinds: ['chat', 'report', 'slides', 'image', 'av'],
        privacy: { externalDataGuard: false, allowUserRawExternal: false },
      },
    }),
  )
  await page.route(/\/api\/models$/, (route) =>
    route.fulfill({
      json: {
        models,
        litellmAvailable: true,
        defaultChatModel: 'external/premium',
        autoRouting: {
          enabled: true,
          available: true,
          reason: null,
          classifierModelId: 'strict-local/classifier',
          economyModelIds: ['external/economy-a', 'external/economy-b'],
          qualityEnabled: true,
          qualityAvailable: true,
          qualityReason: null,
          qualityModelIds: ['external/quality'],
        },
      },
    }),
  )
  for (const endpoint of [
    /\/api\/projects(?:\?.*)?$/,
    /\/api\/artifacts(?:\?.*)?$/,
    /\/api\/skills(?:\?.*)?$/,
    /\/api\/memory(?:\?.*)?$/,
    /\/api\/agents(?:\?.*)?$/,
    /\/api\/tools(?:\?.*)?$/,
    /\/api\/templates(?:\?.*)?$/,
    /\/api\/connectors(?:\?.*)?$/,
    /\/api\/connectors\/catalog(?:\?.*)?$/,
  ]) {
    await page.route(endpoint, (route) => route.fulfill({ json: [] }))
  }
  await page.route(/\/api\/files$/, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ json: [] })
      return
    }
    await route.fulfill({
      status: 201,
      json: {
        id: 'draft-file',
        name: 'draft.txt',
        size: 12,
        mime: 'text/plain',
        tokens: 3,
        projectId: null,
        sessionId: null,
        preview: 'draft',
        error: null,
        createdAt: now,
      },
    })
  })

  await page.route(/\/api\/admin\/governance$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: governance })
      return
    }
    const payload = route.request().postDataJSON() as Record<string, unknown>
    state.governancePuts.push(payload)
    if (state.failGovernance) {
      await route.fulfill({ status: 422, json: { detail: 'invalid_auto_routing_policy' } })
      return
    }
    governance = { ...governance, ...payload }
    await route.fulfill({ json: { clearedMessages: 0 } })
  })
  await page.route(/\/api\/admin\/settings$/, (route) =>
    route.fulfill({
      json: {
        litellm: {
          baseUrl: 'http://litellm:4000',
          baseUrlSource: 'database',
          masterKeySet: true,
          masterKeyPreview: '1234',
          masterKeySource: 'database',
        },
        smtp: {
          host: '',
          port: '',
          security: 'starttls',
          username: '',
          from: '',
          appBaseUrl: '',
          passwordSet: false,
          passwordPreview: '',
          hostSource: 'environment',
          passwordResetEnabled: false,
        },
        status: 'ok',
        brand: { name: 'KloudChat', logo: '' },
        enabledKinds: ['chat'],
        tools: { backendBaseUrl: '', features: [] },
        credits: { perUsd: 1_000, budgetHeadroom: 1.1 },
        unpricedModels: [],
      },
    }),
  )

  const collection = /\/api\/sessions(?:\?.*)?$/
  await page.route(collection, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: state.sessions.map((row) => ({ ...row, messages: null })) })
      return
    }
    const payload = route.request().postDataJSON() as Record<string, unknown>
    state.creates.push(payload)
    const createdId = state.creates.length === 1 ? sessionId : 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const row = {
      id: createdId,
      kind: payload.kind ?? 'chat',
      title: '',
      projectId: payload.projectId ?? null,
      agentId: payload.agentId ?? null,
      model: payload.model ?? 'external/premium',
      routingMode: payload.routingMode ?? initialRoutingMode,
      artifactId: null,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      messages: [],
      preview: null,
      messageCount: 0,
    }
    state.sessions = [row]
    await route.fulfill({ status: 201, json: row })
  })
  await page.route(/\/api\/sessions\/[a-z0-9]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)
    const current = state.sessions.find((row) => row.id === id) ?? state.sessions[0]
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: current })
      return
    }
    const payload = route.request().postDataJSON() as Record<string, unknown>
    state.patches.push(payload)
    const updated = { ...current, ...payload }
    state.sessions = state.sessions.map((row) => (row.id === id ? updated : row))
    await route.fulfill({ json: updated })
  })
  await page.route('**/api/sessions/*/messages', async (route) => {
    state.messageRequests.push(route.request().postDataJSON() as Record<string, unknown>)
    const routingMode = state.sessions[0]?.routingMode === 'auto_quality' ? 'auto_quality' : 'auto'
    const quality = routingMode === 'auto_quality'
    const selectedModel =
      routeDecision === 'routed'
        ? quality
          ? 'external/quality'
          : 'external/economy-a'
        : 'external/premium'
    const answer =
      (routeDecision === 'routed') !== quality
        ? '4'
        : '제약 조건을 우선순위·비용·리스크로 나눠 장기 전략을 수립하겠습니다.'
    const executedModel =
      routeDecision === 'routed'
        ? quality
          ? 'openrouter/quality'
          : 'openrouter/economy-a'
        : 'external/premium'
    const costRouting = {
      mode: routingMode,
      decision: routeDecision,
      reasonCode:
        reasonCode ??
        ((routeDecision === 'routed') !== quality ? 'low_complexity' : 'high_complexity'),
      requestedModel: 'external/premium',
      selectedModel,
      executedModel,
      classifierVersion: 'adaptive-router-v1',
      complexity: (routeDecision === 'routed') !== quality ? 'low' : 'high',
      confidence: 0.98,
      classifierModel: 'strict-local/classifier',
      classifierInputTokens: 12,
      classifierOutputTokens: 4,
      ...(routeDecision === 'routed' ? { estimatedCreditsSaved: 39 } : {}),
    }
    state.sessions = state.sessions.map((row) => ({
      ...row,
      messages: [
        {
          id: 'user-message',
          role: 'user',
          content: 'saved prompt',
          attachments: [],
          steps: null,
          variants: null,
          usage: null,
          model: null,
          routing: null,
          createdAt: now,
        },
        {
          id: 'assistant-message',
          role: 'assistant',
          content: answer,
          attachments: [],
          steps: null,
          variants: null,
          usage: { inputTokens: 3, outputTokens: 1, credits: 1 },
          model: costRouting.executedModel,
          routing: {
            requestedModels: [costRouting.requestedModel],
            routedModels: [costRouting.selectedModel],
            effectiveModels: [costRouting.selectedModel],
            actualModels: [costRouting.executedModel],
            actualModel: costRouting.executedModel,
            action: 'none',
            dataBoundary: 'external',
            costRouting,
          },
          createdAt: now,
        },
      ],
      messageCount: 2,
    }))
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: [
        `data: ${JSON.stringify({ type: 'model_route', ...costRouting })}`,
        `data: ${JSON.stringify({ type: 'model_route', routedModel: selectedModel, actualModel: executedModel })}`,
        `data: ${JSON.stringify({
          type: 'privacy_route',
          requestedModels: ['external/premium'],
          routedModels: [costRouting.selectedModel],
          effectiveModels: [costRouting.selectedModel],
          actualModels: [costRouting.executedModel],
          actualModel: costRouting.executedModel,
          action: 'none',
          dataBoundary: 'external',
        })}`,
        `data: ${JSON.stringify({ type: 'delta', text: answer })}`,
        'data: {"type":"usage","inputTokens":3,"outputTokens":1,"credits":1}',
        'data: {"type":"done"}',
        '',
      ].join('\n'),
    })
  })

  if (initialRoutingMode !== 'manual') {
    state.sessions = [
      {
        id: sessionId,
        kind: 'chat',
        title: 'Auto 대화',
        projectId: null,
        agentId: null,
        model: 'external/premium',
        routingMode: initialRoutingMode,
        artifactId: null,
        pinned: false,
        createdAt: now,
        updatedAt: now,
        messages: [],
        preview: null,
        messageCount: 0,
      },
    ]
  }

  return state
}

for (const mode of ['auto', 'auto_quality'] as const) {
  test.describe(mode, () => {
    const quality = mode === 'auto_quality'
    const laneName = quality ? /Auto · 품질 우선/ : /Auto · 비용 절약/
    const bypassHint = quality
      ? 'Auto · 품질 우선 · 이번 요청은 기능 사용으로 현재 모델 유지'
      : 'Auto · 이번 요청은 기능 사용으로 품질 모델 유지'

    test('자동 검색은 모델 유지를 예고하지 않고 명시 검색만 기능 우회를 안내한다', async ({
      page,
    }) => {
      await mockApp(page, mode)
      await page.goto(`/s/${sessionId}`)
      await expect(page.getByRole('button', { name: laneName })).toBeVisible()
      await expect(page.getByRole('button', { name: '웹 검색: 자동', exact: true })).toBeVisible()
      await expect(page.getByText(bypassHint)).toHaveCount(0)

      await page.getByRole('button', { name: '웹 검색: 자동', exact: true }).click()
      await expect(page.getByText(bypassHint)).toBeVisible()
      await page.getByRole('button', { name: '웹 검색: 켬', exact: true }).click()
      await expect(page.getByText(bypassHint)).toHaveCount(0)

      if ((page.viewportSize()?.width ?? 1440) >= 640) {
        await page.getByLabel('파일 선택').setInputFiles({
          name: 'draft.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('draft'),
        })
        await expect(page.getByText(bypassHint)).toBeVisible()
        await page.getByRole('button', { name: '모델 비교' }).click()
        await page.getByRole('menuitem').filter({ hasText: '비교 모드' }).click()
        await expect(page.getByText('Auto 일시 중지 · 비교할 모델을 직접 실행')).toBeVisible()
        await expect(page.getByText(bypassHint)).toHaveCount(0)
      }
    })

    test('새 대화에서 Auto는 실모델과 함께 한 번만 생성되고 라우팅 결과를 항상 표시한다', async ({
      page,
    }) => {
      const state = await mockApp(page)
      await page.goto('/new/chat')
      await disableWebSearch(page)

      await page.getByLabel('프롬프트 입력').fill('전환 후에도 남을 초안')
      await page.getByLabel('파일 선택').setInputFiles({
        name: 'draft.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('draft'),
      })
      await expect(page.getByRole('button', { name: 'draft.txt 제거' })).toBeVisible()
      await page.getByRole('button', { name: /Mock · Premium/ }).click()
      await captureAutoRouting(page, `${mode}-model-picker.png`)
      await page.getByRole('button', { name: laneName }).click()

      await expect(page).toHaveURL(`/s/${sessionId}`)
      await expect(page.getByLabel('프롬프트 입력')).toHaveValue('전환 후에도 남을 초안')
      await expect(page.getByText('draft.txt')).toBeVisible()
      await expect(page.getByText(bypassHint)).toBeVisible()
      await captureAutoRouting(page, `${mode}-bypass-preview.png`)
      expect(state.creates).toHaveLength(1)
      expect(state.creates[0]).toMatchObject({
        kind: 'chat',
        model: 'external/premium',
        routingMode: mode,
      })
      expect(state.creates[0].model).not.toBe('auto')

      await page.getByRole('button', { name: 'draft.txt 제거' }).click()
      await page
        .getByLabel('프롬프트 입력')
        .fill(quality ? '여러 제약을 분석해 장기 전략을 수립해줘' : '2 더하기 2는?')
      await page.getByLabel('프롬프트 입력').press('Enter')
      await openRoutingDetails(page)
      const selected = quality ? 'Quality' : 'Economy A'
      const selectedId = quality ? 'quality' : 'economy-a'
      const decisionLabel = quality ? 'Auto · 품질 우선 · 상위 모델 선택' : 'Auto 절약'
      const routeBadge = page.getByText(
        new RegExp(
          `${decisionLabel}.*요청 모델.*Premium.*선택 모델.*${selected}.*실행 모델.*openrouter/${selectedId}`,
        ),
      )
      await expect(routeBadge).toBeVisible()
      if (quality) await expect(routeBadge).not.toContainText('Auto 절약')
      else await expect(routeBadge).toContainText('예상 39 크레딧 절약')
      const routeTitle = `요청 모델: Mock · Premium (external/premium) · 선택 모델: Mock · ${selected} (external/${selectedId}) · 실행 모델: openrouter/${selectedId}`
      await expect(routeBadge).toHaveAttribute('title', routeTitle)
      await captureAutoRouting(page, `${mode}-request-routed.png`)
      await expect(page.getByText(/3 in.*1 out/)).toHaveCount(0)
      await page.reload()
      await openRoutingDetails(page)
      await expect(routeBadge).toBeVisible()
      await expect(routeBadge).toHaveAttribute('title', routeTitle)
      await expect(page.getByRole('button', { name: laneName })).toBeVisible()
      expect(state.sessions[0].routingMode).toBe(mode)

      await page.goto('/new/chat')
      await page.getByLabel('프롬프트 입력').fill('새 대화는 manual')
      await page.getByLabel('프롬프트 입력').press('Enter')
      await expect.poll(() => state.creates.length).toBe(2)
      expect(state.creates[1]).toMatchObject({
        model: 'external/premium',
        routingMode: 'manual',
      })
    })

    test('라우팅 기준에 따라 현재 모델을 유지한 이유를 표시한다', async ({ page }) => {
      await mockApp(page, mode, 'kept_quality')
      await page.goto(`/s/${sessionId}`)
      await disableWebSearch(page)

      await page
        .getByLabel('프롬프트 입력')
        .fill(quality ? '2 더하기 2는?' : '여러 제약을 분석해 장기 전략을 수립해줘')
      await page.getByLabel('프롬프트 입력').press('Enter')
      await openRoutingDetails(page)
      await expect(
        page.getByText(
          quality
            ? 'Auto · 품질 우선 · 간단한 요청으로 현재 모델 유지'
            : 'Auto · 복잡한 요청으로 품질 모델 유지',
        ),
      ).toBeVisible()
      await captureAutoRouting(page, `${mode}-request-kept-model.png`)
    })

    test('Auto 품질 모델이 사라진 요청은 초안과 첨부를 보존하고 모델 선택을 안내한다', async ({
      page,
    }) => {
      await mockApp(page, mode)
      await page.route(`**/api/sessions/${sessionId}/messages`, (route) =>
        route.fulfill({
          status: 409,
          json: { detail: 'auto_quality_model_required' },
        }),
      )
      await page.goto(`/s/${sessionId}`)

      await page.getByLabel('프롬프트 입력').fill('보존해야 하는 초안')
      await page.getByLabel('파일 선택').setInputFiles({
        name: 'draft.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('draft'),
      })
      await page.getByLabel('프롬프트 입력').press('Enter')

      await expect(
        page.getByText(
          'Auto에 사용할 품질 모델을 다시 선택하세요. 초안과 첨부 파일은 그대로 보관했습니다.',
        ),
      ).toBeVisible()
      await expect(page.getByLabel('프롬프트 입력')).toHaveValue('보존해야 하는 초안')
      await expect(page.getByText('draft.txt')).toBeVisible()
    })

    test('새 대화의 Auto 생성 실패도 작성 중인 내용을 잃지 않는다', async ({ page }) => {
      await mockApp(page)
      await page.route(/\/api\/sessions$/, (route) =>
        route.fulfill({ status: 503, json: { detail: 'session_create_unavailable' } }),
      )
      await page.goto('/new/chat')

      await page.getByLabel('프롬프트 입력').fill('생성 실패 후 남을 초안')
      await page.getByLabel('파일 선택').setInputFiles({
        name: 'draft.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('draft'),
      })
      await page.getByRole('button', { name: /Mock · Premium/ }).click()
      await page.getByRole('button', { name: laneName }).click()

      await expect(page.getByText('Auto를 켜지 못했습니다. 잠시 후 다시 시도하세요.')).toBeVisible()
      await expect(page.getByLabel('프롬프트 입력')).toHaveValue('생성 실패 후 남을 초안')
      await expect(page.getByText('draft.txt')).toBeVisible()
    })

    test('기존 대화의 Auto PATCH 실패는 manual로 되돌리고 초안을 보존한다', async ({ page }) => {
      const state = await mockApp(page)
      state.sessions = [
        {
          id: sessionId,
          kind: 'chat',
          title: 'Manual 대화',
          projectId: null,
          agentId: null,
          model: 'external/premium',
          routingMode: 'manual',
          artifactId: null,
          pinned: false,
          createdAt: now,
          updatedAt: now,
          messages: [],
          preview: null,
          messageCount: 0,
        },
      ]
      await page.route(new RegExp(`/api/sessions/${sessionId}$`), async (route) => {
        if (route.request().method() !== 'PATCH') {
          await route.fallback()
          return
        }
        await route.fulfill({ status: 503, json: { detail: 'patch_unavailable' } })
      })
      await page.goto(`/s/${sessionId}`)

      await page.getByLabel('프롬프트 입력').fill('PATCH 실패 후 남을 초안')
      await page.getByLabel('파일 선택').setInputFiles({
        name: 'draft.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('draft'),
      })
      await page.getByRole('button', { name: /Mock · Premium/ }).click()
      await page.getByRole('button', { name: laneName }).click()

      await expect(page.getByText('Auto를 켜지 못했습니다. 잠시 후 다시 시도하세요.')).toBeVisible()
      await expect(page.getByLabel('프롬프트 입력')).toHaveValue('PATCH 실패 후 남을 초안')
      await expect(page.getByText('draft.txt')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Mock · Premium', exact: true })).toBeVisible()
    })

    test('실모델 직접 선택은 모델과 manual 모드를 한 번에 저장한다', async ({ page }) => {
      const state = await mockApp(page, mode)
      await page.goto(`/s/${sessionId}`)

      await page.getByRole('button', { name: laneName }).click()
      await page.getByRole('button', { name: /Mock · Economy B/ }).click()

      await expect.poll(() => state.patches.length).toBe(1)
      expect(state.patches[0]).toEqual({ model: 'external/economy-b', routingMode: 'manual' })
    })

    test('Auto PATCH 중 Enter는 전송하지 않고 저장 뒤 다시 누르면 한 번 전송한다', async ({
      page,
    }) => {
      const state = await mockApp(page)
      state.sessions = [
        {
          id: sessionId,
          kind: 'chat',
          title: 'Manual 대화',
          projectId: null,
          agentId: null,
          model: 'external/premium',
          routingMode: 'manual',
          artifactId: null,
          pinned: false,
          createdAt: now,
          updatedAt: now,
          messages: [],
          preview: null,
          messageCount: 0,
        },
      ]
      let releasePatch = () => undefined
      const patchGate = new Promise<void>((resolve) => {
        releasePatch = resolve
      })
      await page.route(new RegExp(`/api/sessions/${sessionId}$`), async (route) => {
        if (route.request().method() !== 'PATCH') {
          await route.fallback()
          return
        }
        const payload = route.request().postDataJSON() as Record<string, unknown>
        state.patches.push(payload)
        await patchGate
        state.sessions = state.sessions.map((row) =>
          row.id === sessionId ? { ...row, ...payload } : row,
        )
        await route.fulfill({ json: state.sessions[0] })
      })

      await page.goto(`/s/${sessionId}`)
      await page.getByLabel('프롬프트 입력').fill('설정 저장 뒤 전송')
      await page.getByRole('button', { name: /Mock · Premium/ }).click()
      await page.getByRole('button', { name: laneName }).click()
      await expect.poll(() => state.patches.length).toBe(1)

      await page.getByLabel('프롬프트 입력').press('Enter')
      await page.waitForTimeout(100)
      expect(state.messageRequests).toHaveLength(0)

      releasePatch()
      await expect(page.getByLabel('프롬프트 입력')).toHaveValue('설정 저장 뒤 전송')
      await expect(page.getByRole('button', { name: '전송' })).toBeEnabled()
      await page.getByLabel('프롬프트 입력').press('Enter')
      await expect.poll(() => state.messageRequests.length).toBe(1)
      expect(state.patches[0]).toEqual({ routingMode: mode })
      expect(state.sessions[0].routingMode).toBe(mode)
    })

    test('비교 모드는 Auto를 바꾸지 않고 품질 모델 유지 이유를 표시한다', async ({ page }) => {
      test.skip(
        (page.viewportSize()?.width ?? 1440) < 640,
        '모델 비교 전환 버튼은 데스크톱에서만 제공됨',
      )
      const state = await mockApp(page, mode)
      await page.goto(`/s/${sessionId}`)

      await page.getByRole('button', { name: '모델 비교' }).click()
      await page.getByRole('menuitem').filter({ hasText: '비교 모드' }).click()

      await expect(page.getByText('Auto 일시 중지 · 비교할 모델을 직접 실행')).toBeVisible()
      await expect(page.getByRole('button', { name: laneName })).toHaveCount(0)
      expect(state.patches).toHaveLength(0)
      await captureAutoRouting(page, `${mode}-compare-paused.png`)
    })
  })
}

test('품질 상향 응답은 절약 모드로 오표시하지 않고 모드를 바꿔도 이력을 보존한다', async ({
  page,
}) => {
  await mockApp(page, 'auto_quality')
  await page.goto(`/s/${sessionId}`)
  await disableWebSearch(page)
  await page.getByLabel('프롬프트 입력').fill('여러 제약을 분석해 장기 전략을 수립해줘')
  await page.getByLabel('프롬프트 입력').press('Enter')
  await openRoutingDetails(page)
  const routeBadge = page.getByText(/요청 모델:.*선택 모델:.*실행 모델:/)
  await expect(routeBadge).toBeVisible()
  await captureAutoRouting(page, 'quality-route-label.png')
  await expect(routeBadge).toContainText('Auto · 품질 우선 · 상위 모델 선택')
  await expect(routeBadge).not.toContainText('Auto 절약')
  await expect(routeBadge).toContainText('예상 39 크레딧 절약')

  await page.getByRole('button', { name: /Auto · 품질 우선/ }).click()
  await page.getByRole('button', { name: /Mock · Economy B/ }).click()
  await page.reload()
  await openRoutingDetails(page)
  await expect(page.getByRole('button', { name: 'Mock · Economy B', exact: true })).toBeVisible()
  await expect(routeBadge).toContainText('Auto · 품질 우선 · 상위 모델 선택')
})

for (const [decision, reasonCode, expected] of [
  ['kept_quality', 'no_quality_model', '사용할 상위 모델이 없어 현재 모델 유지'],
  ['kept_quality', 'input_too_long', '긴 대화이므로 현재 모델 유지'],
  ['kept_quality', 'uncertain', '확실하지 않아 현재 모델 유지'],
  ['classifier_unavailable', 'classifier_failed', '분류기를 사용할 수 없어 현재 모델 유지'],
  ['bypassed', 'unsupported_turn', '기능 사용으로 현재 모델 유지'],
  ['bypassed', 'disabled', '관리 정책이 꺼져 현재 모델 유지'],
  ['bypassed', 'privacy_detected', '개인정보 감지로 난이도 판정 생략'],
] as const) {
  test(`품질 모드의 ${reasonCode} 결과는 유지 이유와 모드를 표시한다`, async ({ page }) => {
    await mockApp(page, 'auto_quality', decision, reasonCode)
    await page.goto(`/s/${sessionId}`)
    await disableWebSearch(page)
    await page.getByLabel('프롬프트 입력').fill('요청 조건을 확인해줘')
    await page.getByLabel('프롬프트 입력').press('Enter')
    await openRoutingDetails(page)
    const routeBadge = page.getByText(/요청 모델:.*선택 모델:.*실행 모델:/)
    await expect(routeBadge).toBeVisible()
    await expect(routeBadge).toContainText(`Auto · 품질 우선 · ${expected}`)
    await page.reload()
    await openRoutingDetails(page)
    await expect(routeBadge).toContainText(`Auto · 품질 우선 · ${expected}`)
  })
}

for (const mode of ['auto', 'auto_quality'] as const) {
  test(`${mode} 처리 내역의 전체 모델 정보는 화면 안에 표시한다`, async ({ page }) => {
    const state = await mockApp(page, mode)
    let releaseRefresh!: () => void
    let refreshRequested!: () => void
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const refreshStarted = new Promise<void>((resolve) => { refreshRequested = resolve })
    await page.route(new RegExp(`/api/sessions/${sessionId}$`), async (route) => {
      if (route.request().method() === 'GET' && state.messageRequests.length > 0) {
        refreshRequested()
        await refreshGate
      }
      await route.fallback()
    })
    await page.goto(`/s/${sessionId}`)
    await disableWebSearch(page)
    await page.getByLabel('프롬프트 입력').fill('요청 조건을 확인해줘')
    await page.getByLabel('프롬프트 입력').press('Enter')
    const routeBadge = page.getByText(/요청 모델:.*선택 모델:.*실행 모델:/)
    const savedQuestion = page.getByText('saved prompt', { exact: true })
    try {
      await refreshStarted
      await openRoutingDetails(page)
      await expect(routeBadge).toBeVisible()
      // This marker comes only from the GET transcript, never the prompt or SSE.
      await expect(savedQuestion).toHaveCount(0)
    } finally {
      releaseRefresh()
    }
    // Reconciliation replaces optimistic message IDs; measure the stored transcript.
    await expect(savedQuestion).toBeVisible()
    await openRoutingDetails(page)
    await expect(routeBadge).toBeVisible()
    const bounds = await routeBadge.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await captureAutoRouting(page, `${mode}-route-width.png`)
    expect(await routeBadge.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  })
}

test('품질 라우팅 결과는 영어 화면에서도 모드와 모델 정보를 구분한다', async ({ page }) => {
  await mockApp(page, 'auto_quality')
  await page.goto(`/s/${sessionId}`)
  await disableWebSearch(page)
  await page.getByLabel('프롬프트 입력').fill('여러 제약을 분석해 장기 전략을 수립해줘')
  await page.getByLabel('프롬프트 입력').press('Enter')
  await openRoutingDetails(page)
  await page.getByRole('button', { name: '언어 전환 · EN' }).click()
  const routeBadge = page.getByText(/Requested model:.*Selected model:.*Executed model:/)
  await expect(routeBadge).toContainText('Auto quality · Selected a higher-tier model')
  await expect(routeBadge).toContainText('Requested model: Mock · Premium')
  await expect(routeBadge).toContainText('Selected model: Mock · Quality')
  await expect(routeBadge).toContainText('Executed model: openrouter/quality')
})

test('절약에서 품질로 전환을 저장하지 못하면 이전 절약 모드로 복구한다', async ({ page }) => {
  const state = await mockApp(page, 'auto')
  await page.route(new RegExp(`/api/sessions/${sessionId}$`), async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback()
      return
    }
    state.patches.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ status: 503, json: { detail: 'patch_unavailable' } })
  })
  await page.goto(`/s/${sessionId}`)
  await page.getByLabel('프롬프트 입력').fill('모드 변경 실패 후에도 남을 초안')
  await page.getByRole('button', { name: /Auto · 비용 절약/ }).click()
  await page.getByRole('button', { name: /Auto · 품질 우선/ }).click()

  await expect(page.getByText('Auto를 켜지 못했습니다. 잠시 후 다시 시도하세요.')).toBeVisible()
  await expect(page.getByRole('button', { name: /Auto · 비용 절약/ })).toBeVisible()
  await expect(page.getByLabel('프롬프트 입력')).toHaveValue('모드 변경 실패 후에도 남을 초안')
  expect(state.patches).toEqual([{ routingMode: 'auto_quality' }])
  expect(state.sessions[0].routingMode).toBe('auto')
})

test('관리자 라우팅 설정은 실패를 성공으로 표시하지 않고 우선순위를 보존한다', async ({ page }) => {
  const state = await mockApp(page)
  await page.goto('/admin/system/routing')

  await page.getByRole('switch', { name: 'Auto 비용 절약 라우팅' }).click()
  await page.getByLabel('난이도 분류 모델').selectOption('strict-local/classifier')
  await page.getByLabel('절약 모델 추가').selectOption('external/economy-a')
  await page.getByLabel('절약 모델 추가').selectOption('external/economy-b')
  await page.getByRole('button', { name: /Economy B 우선순위 올리기/ }).click()
  await captureAutoRouting(page, 'admin-routing-settings.png')

  state.failGovernance = true
  await page.getByRole('button', { name: '라우팅 설정 저장' }).click()
  // The refusal is visible and the save is not claimed.
  await expect(page.getByRole('alert')).toContainText('라우팅 설정을 저장하지 못했습니다.')
  await expect(page.getByText('저장했습니다.')).toHaveCount(0)

  state.failGovernance = false
  await page.getByRole('button', { name: '라우팅 설정 저장' }).click()
  await expect(page.getByText('저장했습니다.')).toBeVisible()
  expect(state.governancePuts.at(-1)).toMatchObject({
    adaptiveRoutingEnabled: true,
    adaptiveClassifierModelId: 'strict-local/classifier',
    adaptiveEconomyModelIds: ['external/economy-b', 'external/economy-a'],
  })
})

test('사라진 모델이 남은 정책도 식별자를 다시 보내지 않고 끌 수 있다', async ({ page }) => {
  const state = await mockApp(page)
  await page.route(/\/api\/admin\/governance$/, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          piiMasking: false,
          externalDataGuard: false,
          allowUserRawExternal: false,
          privacySafeModelIds: [],
          intentFilter: false,
          blockedCategories: [],
          retentionDays: 0,
          adaptiveRoutingEnabled: true,
          adaptiveClassifierModelId: 'strict-local/deleted',
          adaptiveEconomyModelIds: ['external/deleted'],
        },
      })
      return
    }
    state.governancePuts.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ json: { clearedMessages: 0 } })
  })
  await page.goto('/admin/system/routing')

  await expect(page.getByLabel('난이도 분류 모델')).toHaveValue('strict-local/deleted')
  await expect(page.getByText('external/deleted')).toBeVisible()
  await page.getByRole('switch', { name: 'Auto 비용 절약 라우팅' }).click()
  await page.getByRole('button', { name: '라우팅 설정 저장' }).click()

  await expect.poll(() => state.governancePuts.length).toBe(1)
  const sent = state.governancePuts[0]
  await expect(page.getByRole('switch', { name: 'Auto 비용 절약 라우팅' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  expect(sent).toMatchObject({ adaptiveRoutingEnabled: false })
  // Dead model ids the form holds for display must not be written back into the policy.
  expect(Object.keys(sent)).not.toContain('adaptiveClassifierModelId')
  expect(Object.keys(sent)).not.toContain('adaptiveEconomyModelIds')
  expect(JSON.stringify(sent), '사라진 모델 식별자가 다시 올라갔다').not.toContain('deleted')
})
