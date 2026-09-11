# English Audit Authentication Gates

## Scope

- Addresses the false-success path in issue #39; product UI/API code is unchanged.
- Uses the existing `E2E_ADMIN` fixture or `KCHAT_E2E_EMAIL` / `KCHAT_E2E_PASSWORD`.
  The audit never creates an account. A seeded, active administrator must already exist.
- Checks login HTTP status, session shape, account identity, active/admin status,
  and the authenticated application shell before any workspace scan.
- Checks refresh identity after each full navigation, exact pathname, page heading,
  and selected route/button tabs. Required clicks no longer ignore failures.
- Adds the existing `/settings/access` route. Disabled password reset is reported
  as not audited, rather than being counted as a visited screen.
- Retains the original `ALLOWED` and `SEEDED_BY_TESTS` lists without expansion.

## Verification

Base: `f53797251940ff6ddbc0d0eff657a1779664aa51`.

- Before: the original audit flow on the real React app with a synthetic HTTP 401
  printed `0` findings and returned `[]`. The new rejection assertion failed.
- After: 15 Chromium regressions passed against a freshly built production preview
  at `127.0.0.1:5193` (one worker, synthetic API responses only).
- The isolated regression configuration also runs in the existing web CI job;
  no real seeded administrator or database is required for that CI step.
- Negative cases: HTTP 401, pending account, non-admin, malformed auth response,
  lost refresh session, redirect, wrong screen, ignored navigation tab, ignored
  button tab, and unopened account menu.
- Positive controls: authenticated zero findings, a detected synthetic Korean
  marker, settings/security navigation tabs, disabled image screen, and governance tabs.
- All API requests are intercepted; external origins and non-auth writes are blocked.
  No account creation, original database access, or model generation was performed.
- Full lint: 196 existing warnings, zero errors. Changed-file lint and explicit
  test/config TypeScript checks passed. Production build passed with the existing
  12 `phone` CSS warnings and large-bundle notice; those are outside this patch.
- The owned preview process exited and port 5193 was closed after verification.

Run from `apps/web`:

```sh
npx playwright test --config playwright.i18n-gates.config.ts
npx oxlint --deny-warnings e2e/i18n-audit.ts e2e/i18n-audit.spec.ts e2e/i18n-audit-gates.spec.ts playwright.i18n-gates.config.ts
npx tsc --ignoreConfig --noEmit --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --types node e2e/i18n-audit.ts e2e/i18n-audit.spec.ts e2e/i18n-audit-gates.spec.ts playwright.i18n-gates.config.ts
```

## Not Verified or Resolved

This is not a full translation audit of a real workspace or all shipped content.
The expectations for shipped template checklists, seeded catalogue content, and
other data remain a separate product-policy decision from issue #39. Existing
translation exemptions may still hide mixed-language content; this patch does
not widen them or claim that every interface string is translated. No physical
phone or Safari verification was performed.
