import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import style from './fixtures/report-table-style.json' with { type: 'json' }
import expectedMerged from './fixtures/report-table-merged.json' with { type: 'json' }
import expectedSplit from './fixtures/report-table-split.json' with { type: 'json' }
import expectedFullWidth from './fixtures/report-table-full-width-merged.json' with { type: 'json' }

test.use({ serviceWorkers: 'block' })

const sessionId = '11111111111111111111111111111111'
const artifactId = '22222222222222222222222222222222'
const at = '2026-09-12T00:00:00.000Z'
const original = '<table><tbody><tr><th><p>Item</p></th><th><p>Value</p></th><th><p>Owner</p></th></tr><tr><td><p>Alpha</p></td><td><p>10</p></td><td><p>A</p></td></tr><tr><td><p>Beta</p></td><td><p>20</p></td><td><p>B</p></td></tr></tbody></table>'

async function fixture(page: Page, testInfo: TestInfo) {
  const origin = new URL(String(testInfo.project.use.baseURL)).origin
  expect(['localhost', '127.0.0.1']).toContain(new URL(origin).hostname)
  const unexpected: string[] = []
  const writes: unknown[] = []
  let artifact = {
    id: artifactId, title: 'Table roundtrip', kind: 'report', version: 1, partial: false,
    sessionId, projectId: null, createdAt: at, updatedAt: at,
    data: { kind: 'report', title: 'Table roundtrip', sources: [],
      sections: [{ id: 'table-section', heading: 'Comparison', content: original, format: 'html', status: 'done' }] },
  }
  const session = { id: sessionId, title: artifact.title, kind: 'report', model: 'fixture/base', routingMode: 'manual',
    projectId: null, agentId: null, artifactId, pinned: false, messages: [], messageCount: 0,
    made: null, createdAt: at, updatedAt: at }
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
    if (method === 'GET' && path === '/design-templates/doc-report/style') return route.fulfill({ json: style })
    if (method === 'POST' && path === '/auth/refresh') return route.fulfill({ json: { accessToken: 'fixture-only', expiresIn: 3600,
      user: { id: 'fixture-user', name: 'Report fixture', email: 'fixture@example.test', role: 'user',
        status: 'active', monthlyCredits: 1000, creditsUsed: 0, avatarColor: '#168267', allowedModels: [],
        createdAt: at, preferences: { autoMemory: false, showUsage: false, streamResponses: true } } } })
    if (method === 'GET' && path === '/auth/config') return route.fulfill({ json: { brand: { name: 'KloudChat', logo: '' },
      enabledKinds: ['chat', 'report'], privacy: { externalDataGuard: false }, passwordResetEnabled: false,
      dictationEnabled: false } })
    if (method === 'GET' && path === '/models') return route.fulfill({ json: { models: [{ id: 'fixture/base', label: 'Fixture',
      name: 'Fixture', vendor: 'Fixture', provider: 'fixture', kinds: ['chat', 'report'], modality: 'chat',
      dataBoundary: 'external', creditCost: 1, inputCreditCost: 1, supportsTools: true, contextWindow: 64000 }],
      defaultChatModel: 'fixture/base', litellmAvailable: false, autoRouting: { enabled: false, available: false } } })
    if (method === 'GET' && path === '/credits') return route.fulfill({ json: { monthlyCredits: 1000, creditsUsed: 0, creditsRemaining: 1000 } })
    if (method === 'GET' && path === '/sessions') return route.fulfill({ json: [session] })
    if (method === 'GET' && path === `/sessions/${sessionId}`) return route.fulfill({ json: session })
    if (method === 'GET' && path === '/artifacts') return route.fulfill({ json: [artifact] })
    if (method === 'GET' && path === `/artifacts/${artifactId}`) return route.fulfill({ json: artifact })
    if (method === 'PATCH' && path === `/artifacts/${artifactId}`) {
      const patch = request.postDataJSON()
      expect(patch.expectedVersion).toBe(artifact.version)
      writes.push(patch)
      artifact = { ...artifact, title: patch.title ?? artifact.title, data: patch.data, version: artifact.version + 1 }
      return route.fulfill({ json: artifact })
    }
    if (method === 'GET' && path === '/artifacts/counts') return route.fulfill({ json: { counts: { report: 1 }, total: 1 } })
    if (method === 'GET' && [`/sessions/${sessionId}/messages`, `/sessions/${sessionId}/jobs`, '/projects',
      '/skills', '/memory', '/agents', '/tools', '/templates', '/connectors', '/connectors/catalog', '/jobs',
      '/designs', '/design-templates', '/prompt-templates', '/shares'].includes(path)) return route.fulfill({ json: [] })
    unexpected.push(`${method} ${path}`)
    return route.abort('blockedbyclient')
  })
  await page.goto(`/s/${sessionId}?artifact=${artifactId}`)
  return { unexpected, writes, stored: () => structuredClone(artifact) }
}

async function enterEditor(page: Page) {
  await page.getByRole('tab', { name: '편집', exact: true }).click()
  await expect(page.locator('.ProseMirror').first()).toBeVisible()
}

async function save(page: Page) {
  const button = page.getByRole('button', { name: '저장', exact: true })
  await button.click()
  await expect(button).toBeHidden()
}

async function captureReport(testInfo: TestInfo, name: string, data: unknown) {
  const path = testInfo.outputPath(name)
  await writeFile(path, JSON.stringify(data, null, 2))
  await testInfo.attach(name, { path, contentType: 'application/json' })
}

async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(name)
  await page.screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

for (const width of [1440, 390]) {
  test(`restoring the original header row saves the visible table at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    const state = await fixture(page, testInfo)
    await enterEditor(page)
    const editor = page.locator('.ProseMirror').first()
    await expect(editor.locator('th')).toHaveCount(3)
    await editor.locator('th').first().click()
    const header = page.getByRole('button', { name: '첫 행을 머리글로 전환', exact: true })
    await header.click()
    await expect(editor.locator('th')).toHaveCount(0)
    await header.click()
    await expect(editor.locator('th')).toHaveCount(3)
    await save(page)
    await page.reload()
    await enterEditor(page)
    await expect(page.locator('.ProseMirror').first().locator('th')).toHaveCount(3)
    await page.locator('.ProseMirror').first().locator('th').first().click()
    await captureScreenshot(page, testInfo, `restored-header-${width}.png`)
    expect(state.writes).toHaveLength(1)
    expect(state.unexpected).toEqual([])
  })
}

test('opening and focusing a table does not offer a phantom save', async ({ page }, testInfo) => {
  const state = await fixture(page, testInfo)
  await enterEditor(page)
  await page.locator('.ProseMirror').first().locator('th').first().click()
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeHidden()
  await page.reload()
  await enterEditor(page)
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeHidden()
  expect(state.writes).toEqual([])
  expect(state.unexpected).toEqual([])
})

for (const redo of [false, true]) {
  test(`header undo${redo ? ' and redo' : ''} survives save and reload`, async ({ page }, testInfo) => {
    const state = await fixture(page, testInfo)
    await enterEditor(page)
    const editor = page.locator('.ProseMirror').first()
    await editor.locator('th').first().click()
    await page.getByRole('button', { name: '첫 행을 머리글로 전환', exact: true }).click()
    await expect(editor.locator('th')).toHaveCount(0)
    await page.getByRole('button', { name: '실행 취소', exact: true }).click()
    await expect(editor.locator('th')).toHaveCount(3)
    if (redo) {
      await page.getByRole('button', { name: '다시 실행', exact: true }).click()
      await expect(editor.locator('th')).toHaveCount(0)
    }
    await save(page)
    await page.reload()
    await enterEditor(page)
    await expect(editor.locator('th')).toHaveCount(redo ? 0 : 3)
    expect(state.writes).toHaveLength(1)
    expect(state.unexpected).toEqual([])
  })
}

for (const width of [1440, 390]) {
  test(`merged and split cells retain their text and spans at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    const state = await fixture(page, testInfo)
    await enterEditor(page)
    const editor = page.locator('.ProseMirror').first()
    const rows = editor.locator('tr')
    // Shift-click is ProseMirror's native rectangular cell selection, not injected editor state.
    await rows.nth(1).locator('td').nth(0).click()
    await rows.nth(2).locator('td').nth(1).click({ modifiers: ['Shift'] })
    await expect(editor.locator('.selectedCell')).toHaveCount(4)
    await page.getByRole('button', { name: '선택한 셀 병합', exact: true }).click()
    const merged = editor.locator('td[colspan="2"][rowspan="2"]')
    await expect(merged).toHaveCount(1)
    await expect(merged.locator('p')).toHaveText(['Alpha', '10', 'Beta', '20'])
    await save(page)
    const storedMerged = state.stored()
    expect(storedMerged.data).toEqual(expectedMerged)
    await captureReport(testInfo, 'merged-report.json', storedMerged.data)
    await page.reload()
    await enterEditor(page)
    await expect(merged).toHaveCount(1)
    await expect(merged.locator('p')).toHaveText(['Alpha', '10', 'Beta', '20'])
    await merged.click()
    await captureScreenshot(page, testInfo, `merged-${width}.png`)
    await page.getByRole('button', { name: '셀 나누기', exact: true }).click()
    await expect(merged).toHaveCount(0)
    await expect(editor.locator('td')).toHaveCount(6)
    await expect(rows.nth(1).locator('td').first().locator('p')).toHaveText(['Alpha', '10', 'Beta', '20'])
    await save(page)
    expect(state.stored().data).toEqual(expectedSplit)
    await captureReport(testInfo, 'split-report.json', state.stored().data)
    await page.reload()
    await enterEditor(page)
    await expect(editor.locator('td')).toHaveCount(6)
    await expect(rows.nth(1).locator('td').first().locator('p')).toHaveText(['Alpha', '10', 'Beta', '20'])
    await expect(rows.nth(1).locator('td').nth(2)).toHaveText('A')
    await expect(rows.nth(2).locator('td').nth(2)).toHaveText('B')
    await rows.nth(1).locator('td').first().click()
    await captureScreenshot(page, testInfo, `split-${width}.png`)
    expect(state.writes).toHaveLength(2)
    expect(state.unexpected).toEqual([])
  })
}

test('a full-width vertical merge keeps the covered final row on reload', async ({ page }, testInfo) => {
  const state = await fixture(page, testInfo)
  await enterEditor(page)
  const editor = page.locator('.ProseMirror').first()
  await editor.locator('tr').nth(1).locator('td').first().click()
  await editor.locator('tr').nth(2).locator('td').last().click({ modifiers: ['Shift'] })
  await expect(editor.locator('.selectedCell')).toHaveCount(6)
  await page.getByRole('button', { name: '선택한 셀 병합', exact: true }).click()
  await expect(editor.locator('td[colspan="3"][rowspan="2"]')).toHaveCount(1)
  await save(page)
  expect(state.stored().data).toEqual(expectedFullWidth)
  await captureReport(testInfo, 'full-width-merged-report.json', state.stored().data)
  await page.reload()
  await enterEditor(page)
  await expect(editor.locator('td[colspan="3"][rowspan="2"]')).toHaveCount(1)
  await expect(editor.locator('tr')).toHaveCount(3)
  expect(state.unexpected).toEqual([])
})

for (const field of ['title', 'heading'] as const) {
  test(`restoring the original ${field} survives save and reload`, async ({ page }, testInfo) => {
    const state = await fixture(page, testInfo)
    await enterEditor(page)
    const line = page.locator(`${field === 'title' ? 'h1' : 'h2'}[contenteditable="true"]`).first()
    const initial = field === 'title' ? 'Table roundtrip' : 'Comparison'
    await line.fill('Changed text')
    await line.press('Enter')
    await line.fill(initial)
    await line.press('Enter')
    await expect(line).toHaveText(initial)
    await save(page)
    await page.reload()
    await enterEditor(page)
    await expect(line).toHaveText(initial)
    expect(state.writes).toHaveLength(1)
    expect(state.unexpected).toEqual([])
  })

  test(`empty or cancelled ${field} edits do not overwrite the accepted value`, async ({ page }, testInfo) => {
    const state = await fixture(page, testInfo)
    await enterEditor(page)
    const line = page.locator(`${field === 'title' ? 'h1' : 'h2'}[contenteditable="true"]`).first()
    await line.fill('Accepted text')
    await line.press('Enter')
    await line.fill('Cancelled text')
    await line.press('Escape')
    await expect(line).toHaveText('Accepted text')
    await line.fill('   ')
    await line.press('Enter')
    await save(page)
    await page.reload()
    await enterEditor(page)
    await expect(line).toHaveText('Accepted text')
    expect(state.writes).toHaveLength(1)
    expect(state.unexpected).toEqual([])
  })
}
