import { expect, test, type Page } from '@playwright/test'
import { E2E_ADMIN } from './helpers'
import { auditEnglishMode } from './i18n-audit'

type Scenario = 'admin' | '401' | 'pending' | 'nonadmin' | 'malformed' | 'refresh-loss'

async function mockAudit(page: Page, scenario: Scenario = 'admin') {
  const state = {
    loggedIn: false, protectedRequests: 0, namedAccountUsed: false, forbidden: [] as string[],
  }
  const user = {
    id: 'audit-user', email: E2E_ADMIN.email, name: 'Audit fixture',
    role: scenario === 'nonadmin' ? 'user' : 'admin',
    status: scenario === 'pending' ? 'pending' : 'active',
    monthlyCredits: 100, creditsUsed: 0, cycleResetsAt: null, avatarColor: '#64748b',
    preferences: { autoMemory: false }, allowedModels: [],
  }
  const session = { accessToken: 'synthetic-audit-token', expiresIn: 3600, user }
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== 'http://127.0.0.1:5193') {
      state.forbidden.push('external origin')
      await route.abort('blockedbyclient')
      return
    }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const path = url.pathname
    const method = route.request().method()
    if (path === '/api/auth/login' && method === 'POST') {
      const submitted = route.request().postDataJSON()
      state.namedAccountUsed = submitted.email === E2E_ADMIN.email && submitted.password === E2E_ADMIN.password
      if (scenario === '401') return route.fulfill({ status: 401, json: { detail: 'invalid_credentials' } })
      state.loggedIn = true
      return route.fulfill({ json: scenario === 'malformed' ? {} : session })
    }
    if (path === '/api/auth/refresh' && method === 'POST') {
      return route.fulfill(state.loggedIn && scenario !== 'refresh-loss'
        ? { json: session }
        : { status: 401, json: { detail: 'no_refresh_token' } })
    }
    if (method !== 'GET') {
      state.forbidden.push(`${method} ${path}`)
      return route.abort('blockedbyclient')
    }
    if (path === '/api/auth/config') return route.fulfill({ json: {
      passwordResetEnabled: true, brand: { name: 'KloudChat', logo: '' },
      enabledKinds: ['chat'], signupPolicy: 'closed',
      privacy: { externalDataGuard: false, allowUserRawExternal: false },
    } })
    if (path === '/api/auth/me') return route.fulfill({ json: user })
    if (path === '/api/admin/governance') return route.fulfill({ json: {
      piiMasking: false, externalDataGuard: false, allowUserRawExternal: false,
      privacySafeModelIds: [], intentFilter: false, blockedCategories: [], retentionDays: 0,
    } })
    state.protectedRequests += 1
    if (path === '/api/models') return route.fulfill({ json: { models: [], litellmAvailable: false } })
    return route.fulfill({ json: [] })
  })
  return state
}

for (const scenario of ['401', 'pending', 'nonadmin', 'malformed', 'refresh-loss'] as const) {
  test(`${scenario}: an unaudited screen cannot report zero findings`, async ({ page }) => {
    const state = await mockAudit(page, scenario)
    await expect(auditEnglishMode(page, [['/projects', '프로젝트']])).rejects.toThrow(/Audit authentication/)
    expect(state.namedAccountUsed).toBe(true)
    expect(state.forbidden).toEqual([])
  })
}

test('redirect: a different screen is not scanned under the requested route', async ({ page }) => {
  const state = await mockAudit(page)
  await page.route('**/projects', async (route) => {
    if (!route.request().isNavigationRequest()) return route.fallback()
    await route.fulfill({ status: 302, headers: { location: '/' } })
  })
  await expect(auditEnglishMode(page, [['/projects', '프로젝트']])).rejects.toThrow(/Audit route/)
  expect(state.forbidden).toEqual([])
})

test('wrong screen: a shell without the expected page is not enough', async ({ page }) => {
  const state = await mockAudit(page)
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (location.pathname !== '/projects') return
      const heading = document.querySelector('main h1')
      if (heading?.textContent === 'Projects') heading.textContent = 'Unexpected screen'
    }).observe(document, { childList: true, subtree: true })
  })
  await expect(auditEnglishMode(page, [['/projects', '프로젝트']])).rejects.toThrow(/Audit route/)
  expect(state.forbidden).toEqual([])
})

test('an authenticated translated React screen may report zero findings', async ({ page }) => {
  const state = await mockAudit(page)
  expect(await auditEnglishMode(page, [['/projects', '프로젝트']])).toEqual([])
  expect(state.protectedRequests).toBeGreaterThan(0)
  expect(state.namedAccountUsed).toBe(true)
  expect(state.forbidden).toEqual([])
  if (process.env.I18N_AUDIT_SCREENSHOT_DIR) {
    await page.goto('/projects')
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
    await page.screenshot({ path: `${process.env.I18N_AUDIT_SCREENSHOT_DIR}/i18n-audit-authenticated.png` })
  }
})

test('Korean rendered on the actual authenticated screen remains a finding', async ({ page }) => {
  const state = await mockAudit(page)
  await page.route('**/api/projects', (route) => route.fulfill({ json: [{
    id: 'project-fixture', name: '감사누락검증', emoji: 'P', description: '',
    instructions: '', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z',
    files: [], sessionIds: [], skillIds: [],
  }] }))
  const findings = await auditEnglishMode(page, [['/projects', '프로젝트']])
  expect(findings.some((finding) => finding.where === '프로젝트' && finding.text === '감사누락검증')).toBe(true)
  expect(state.forbidden).toEqual([])
})

test('settings/access and its navigation tabs reach their real React screens', async ({ page }) => {
  const state = await mockAudit(page)
  await auditEnglishMode(page, [['/settings/access', '설정·보안']])
  expect(state.forbidden).toEqual([])
})

test('disabled media is audited as its explicit disabled screen', async ({ page }) => {
  const state = await mockAudit(page)
  await auditEnglishMode(page, [['/new/image', '새 이미지']])
  expect(state.forbidden).toEqual([])
})

test('governance button tabs must become selected before scanning', async ({ page }) => {
  const state = await mockAudit(page)
  await auditEnglishMode(page, [['/admin/governance', '관리자·거버넌스']])
  expect(state.forbidden).toEqual([])
})

test('a required tab click that does not navigate fails closed', async ({ page }) => {
  const state = await mockAudit(page)
  await page.addInitScript(() => {
    document.addEventListener('click', (event) => {
      if ((event.target as Element).closest('[role="tab"][href]')) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }, true)
  })
  await expect(auditEnglishMode(page, [['/settings/access', '설정·보안']])).rejects.toThrow(/Audit route/)
  expect(state.forbidden).toEqual([])
})

test('an inactive governance tab cannot be reported as scanned', async ({ page }) => {
  const state = await mockAudit(page)
  await page.addInitScript(() => {
    document.addEventListener('click', (event) => {
      if ((event.target as Element).closest('button[role="tab"]')) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }, true)
  })
  await expect(auditEnglishMode(page, [['/admin/governance', '관리자·거버넌스']]))
    .rejects.toThrow(/Audit navigation: tab was not selected/)
  expect(state.forbidden).toEqual([])
})

test('an account menu that does not open fails closed', async ({ page }) => {
  const state = await mockAudit(page)
  await page.addInitScript(() => {
    document.addEventListener('click', (event) => {
      if ((event.target as Element).closest('button[aria-label^="Account menu"]')) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }, true)
  })
  await expect(auditEnglishMode(page, [['/projects', '프로젝트']]))
    .rejects.toThrow(/Audit navigation: account menu did not open/)
  expect(state.forbidden).toEqual([])
})
