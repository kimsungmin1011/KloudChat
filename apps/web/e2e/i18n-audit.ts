import { expect, type Page, type Response } from '@playwright/test'
import { translate } from '../src/lib/i18n'
import { E2E_ADMIN } from './helpers'

/** Switches to English and reports Korean still rendered on any screen. */

const t = (text: string) => translate('en', text)

/** Korean that is correct to leave: user content and slugs. */
const ALLOWED = [
  /^[가-힣]$/, // 이름 첫 글자로 만든 마크, 언어 토글의 '한'
  /^[가-힣A-Za-z0-9]+(-[가-힣A-Za-z0-9]+)+$/, // 슬러그
  // Mixed English and Korean on one line means interpolated user content.
  /[A-Za-z]{3}.*[가-힣]|[가-힣].*[A-Za-z]{3}/,
]

/** User data seeded by tests; not translated. */
const SEEDED_BY_TESTS = [
  '서울 날씨',
  '예시대학교',
  '스펙트럼 자기지도',
  '라만 스펙트럼 SSL',
  '피크 검출',
  '계산을 반드시 검증',
  '수치의 단위를 검산한다',
  '소속',
  '단위 검산',
  '관리자',
  '기록 삭제 확인용',
  '이름 ',
]

type Finding = { where: string; text: string; selector: string }

async function scan(page: Page, where: string): Promise<Finding[]> {
  await page.waitForTimeout(600)
  return page.evaluate(
    ({ where, patterns, literals }) => {
      const found: { where: string; text: string; selector: string }[] = []
      const seen = new Set<string>()
      const ignore = patterns.map((p) => new RegExp(p))
      const skip = (text: string) =>
        ignore.some((re) => re.test(text)) || literals.some((l) => text.includes(l))

      const label = (el: Element): string => {
        const parts: string[] = []
        let cur: Element | null = el
        for (let i = 0; cur && i < 3; i++) {
          const tag = cur.tagName.toLowerCase()
          const cls = (cur.getAttribute('class') || '').split(/\s+/).slice(0, 2).join('.')
          parts.unshift(cls ? `${tag}.${cls}` : tag)
          cur = cur.parentElement
        }
        return parts.join(' > ')
      }

      const visible = (el: Element): boolean => {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) return false
        const s = getComputedStyle(el)
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
      }

      // Per text node, so a string is reported once.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = (n.textContent || '').trim()
        if (!text || !/[가-힣]/.test(text)) continue
        const el = n.parentElement
        if (!el || !visible(el)) continue
        if (skip(text)) continue
        const key = `${where}|${text}`
        if (seen.has(key)) continue
        seen.add(key)
        found.push({ where, text, selector: label(el) })
      }

      // Attributes a screen reader reads.
      for (const attr of ['aria-label', 'placeholder', 'title', 'alt']) {
        for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) {
          const text = (el.getAttribute(attr) || '').trim()
          if (!text || !/[가-힣]/.test(text)) continue
          if (!visible(el)) continue
          if (skip(text)) continue
          const key = `${where}|${attr}|${text}`
          if (seen.has(key)) continue
          seen.add(key)
          found.push({ where, text: `[${attr}] ${text}`, selector: label(el) })
        }
      }
      return found
    },
    { where, patterns: ALLOWED.map((r) => r.source), literals: SEEDED_BY_TESTS },
  )
}

export const AUDIT_ROUTES: [string, string][] = [
  ['/', '홈'],
  ['/new/chat', '새 챗'],
  ['/new/report', '새 보고서'],
  ['/new/slides', '새 슬라이드'],
  ['/new/image', '새 이미지'],
  ['/new/av', '새 오디오·동영상'],
  ['/projects', '프로젝트'],
  ['/artifacts', '아티팩트'],
  ['/agents', '에이전트'],
  ['/skills', '스킬'],
  ['/memory', '메모리'],
  ['/history', '기록'],
  ['/usage', '사용량'],
  ['/connectors', '커넥터'],
  ['/agent-setup', 'AI 에이전트 연동'],
  ['/designs', '디자인'],
  ['/settings', '설정'],
  ['/settings/preferences', '설정·환경설정'],
  ['/settings/keys', '설정·API 키'],
  ['/settings/access', '설정·보안'],
  ['/admin/users', '관리자·사용자'],
  ['/admin/usage', '관리자·사용량'],
  ['/admin/system', '관리자·시스템'],
  ['/admin/system/routing', '관리자·라우팅'],
  ['/admin/system/features', '관리자·기능'],
  ['/admin/system/templates', '관리자·공용 템플릿'],
  ['/admin/system/branding', '관리자·브랜딩'],
  ['/admin/system/mail', '관리자·메일'],
  ['/admin/governance', '관리자·거버넌스'],
]

const HEADINGS: Record<string, string> = {
  '/projects': '프로젝트', '/artifacts': '아티팩트', '/agents': '에이전트',
  '/skills': '스킬', '/memory': '메모리', '/history': '대화 기록', '/usage': '사용량',
  '/connectors': '커넥터', '/agent-setup': 'AI 에이전트 연동', '/designs': '디자인',
  '/admin/users': '사용자 · 크레딧', '/admin/usage': '사용량', '/admin/governance': '보안 · 감사',
}
const KINDS: Record<string, string> = {
  chat: '챗', report: '보고서', slides: '슬라이드', image: '이미지', av: '오디오/동영상',
}

async function activeAdmin(response: Response, stage: string, expectedId?: string): Promise<string> {
  if (response.status() !== 200) {
    throw new Error(`Audit authentication: ${stage} HTTP ${response.status()}`)
  }
  const payload = await response.json().catch(() => null)
  const user = payload?.user
  // Never include the response, token, password, or account details in assertion output.
  if (
    typeof payload?.accessToken !== 'string' || !payload.accessToken.trim()
    || typeof payload?.expiresIn !== 'number' || !Number.isFinite(payload.expiresIn)
    || payload.expiresIn <= 0 || typeof user?.id !== 'string' || !user.id
    || typeof user.email !== 'string' || user.email.toLowerCase() !== E2E_ADMIN.email.toLowerCase()
  ) throw new Error(`Audit authentication: ${stage} returned an invalid session`)
  if (user.status !== 'active' || user.role !== 'admin') {
    throw new Error(`Audit authentication: ${stage} requires an active administrator`)
  }
  if (expectedId && user.id !== expectedId) {
    throw new Error(`Audit authentication: ${stage} changed account identity`)
  }
  return user.id
}

async function shellReady(page: Page) {
  await expect(page.getByRole('button', { name: t('사이드바 토글'), exact: true }),
    'Audit authentication: authenticated workspace shell is missing').toBeVisible()
  await expect(page.getByRole('heading', { name: t('로그인'), exact: true }),
    'Audit authentication: sign-in screen is not an audited workspace').toHaveCount(0)
}

async function routeReady(page: Page, path: string) {
  await expect(page, `Audit route: did not reach ${path}`).toHaveURL((url) => url.pathname === path)
  await shellReady(page)
  const main = page.getByRole('main')
  const kind = path.startsWith('/new/') ? path.slice('/new/'.length) : null
  const parent = path === '/settings' || path.startsWith('/settings/') ? '설정'
    : path === '/admin/system' || path.startsWith('/admin/system/') ? '시스템' : null
  if (path === '/' || (kind && KINDS[kind])) {
    const greeting = main.getByRole('heading', { level: 1, name: /^Hello, / })
    const off = main.getByRole('heading', {
      level: 1, name: t('{kind} 기능이 꺼져 있습니다').replace('{kind}', t(KINDS[kind ?? 'chat'])),
      exact: true,
    })
    await expect(greeting.or(off), `Audit route: home surface missing at ${path}`).toBeVisible()
    if (await greeting.isVisible()) {
      await expect(main.getByLabel(t('프롬프트 입력'), { exact: true }),
        `Audit route: composer missing at ${path}`).toBeVisible()
      if (kind) await expect(main.getByRole('button', { name: t(KINDS[kind]), exact: true }),
        `Audit route: wrong selected surface at ${path}`).toHaveAttribute('aria-pressed', 'true')
    }
  } else {
    const heading = parent ?? HEADINGS[path]
    if (!heading) throw new Error(`Audit route: no screen contract for ${path}`)
    await expect(main.getByRole('heading', { level: 1, name: t(heading), exact: true }),
      `Audit route: expected screen heading is missing at ${path}`).toBeVisible()
  }
  if (parent) await expect(main.locator(`[role="tab"][href="${path}"]`),
    `Audit route: selected tab is missing at ${path}`).toHaveAttribute('aria-current', 'page')
}

async function visit(page: Page, path: string, userId: string) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/refresh'
      && r.request().method() === 'POST'),
    page.goto(path),
  ])
  await activeAdmin(response, 'refresh', userId)
  await routeReady(page, path)
}

export async function auditEnglishMode(page: Page, routes = AUDIT_ROUTES): Promise<Finding[]> {
  const findings: Finding[] = []

  // Sign-in screen first; the language is planted in localStorage.
  await page.context().clearCookies()
  await page.addInitScript(() => localStorage.setItem('kchat-lang', 'en'))
  const [configResponse] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/config'
      && r.request().method() === 'GET'),
    page.goto('/'),
  ])
  if (configResponse.status() !== 200) throw new Error('Audit navigation: login configuration unavailable')
  const config = await configResponse.json()
  if (typeof config?.passwordResetEnabled !== 'boolean') {
    throw new Error('Audit navigation: invalid password reset configuration')
  }
  await expect(page.getByRole('heading', { name: t('로그인'), exact: true })).toBeVisible()
  findings.push(...(await scan(page, '로그인')))

  if (config.passwordResetEnabled === true) {
    await page.getByRole('button', { name: t('비밀번호를 잊으셨나요?'), exact: true }).click()
    await expect(page.getByRole('heading', { name: t('비밀번호 재설정'), exact: true }),
      'Audit navigation: password reset screen did not open').toBeVisible()
    findings.push(...(await scan(page, '로그인 › 비밀번호 재설정')))
    await page.getByRole('button', { name: t('취소'), exact: true }).click()
    await expect(page.getByRole('heading', { name: t('로그인'), exact: true })).toBeVisible()
  } else {
    console.log('Audit coverage: password reset is disabled; its screen was not audited.')
  }

  await page.getByLabel(t('이메일'), { exact: true }).fill(E2E_ADMIN.email)
  await page.getByLabel(t('비밀번호'), { exact: true }).fill(E2E_ADMIN.password)
  const [loginResponse] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/login'
      && r.request().method() === 'POST'),
    page.locator('form').getByRole('button', { name: t('로그인'), exact: true }).click(),
  ])
  const userId = await activeAdmin(loginResponse, 'login')
  await shellReady(page)

  for (const [path, name] of routes) {
    await visit(page, path, userId)
    findings.push(...(await scan(page, name)))

    const tabs = page.getByRole('tab')
    const count = await tabs.count()
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i)
      const tabName = (await tab.textContent())?.trim()
      if (!tabName) throw new Error(`Audit navigation: unnamed tab at ${path}`)
      const href = await tab.getAttribute('href')
      await tab.click()
      if (href) {
        await routeReady(page, new URL(href, page.url()).pathname)
      } else {
        await expect(tab, `Audit navigation: tab was not selected at ${path}`)
          .toHaveAttribute('aria-selected', 'true')
        await routeReady(page, path)
      }
      findings.push(...(await scan(page, `${name} › ${tabName.trim()}`)))
    }
  }

  // The account menu is a popover, not a route.
  await visit(page, '/', userId)
  const avatar = page.getByRole('button', { name: /^Account menu/ }).filter({ visible: true }).first()
  await avatar.click()
  await expect(page.getByRole('menu'), 'Audit navigation: account menu did not open').toBeVisible()
  findings.push(...(await scan(page, '사용자 메뉴')))
  await page.keyboard.press('Escape')

  const report = findings
    .map((f) => `  [${f.where}] ${f.text}\n      ${f.selector}`)
    .join('\n')
  console.log(`\n=== 영어 모드에 남은 한글: ${findings.length}건 ===\n${report}\n`)

  return findings
}
