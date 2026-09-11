# Session metadata hydration verification

## Scope

- Baseline: `f53797251940ff6ddbc0d0eff657a1779664aa51`.
- Preserve the original session kind and Agent identity when authenticated session metadata or the Agent catalogue arrives late.
- Before a session row is available, render a loading state instead of treating the unknown session as a new chat. A failed detail lookup displays the existing retry action.
- Use the persisted `session.agentId`, not the independently loaded Agent catalogue, to decide whether a chat can hand a document request to another surface.
- When a session inherits its Agent model and the Agent catalogue is not available yet, keep the document request model empty so the existing server-side Agent resolution can run. An explicit session/turn choice or an already loaded Agent model remains unchanged.
- The store/API contracts, ordinary chat-to-document handoff, and new-session creation are unchanged. This is a functional context-preservation fix, not evidence of an authorization or data-disclosure defect.

## Before and after

Two focused baseline browser cases failed before the product edits:

1. A report deep link with session list/detail responses held open exposed the chat composer. Sending a document request created another report and sent to the new ID instead of the original report ID.
2. A chat session with a persisted Agent ID and a delayed Agent catalogue also handed the request to a new report. The existing empty-session cleanup subsequently deleted the original empty Agent session.

The assertions record the mocked HTTP mutations, not just the placeholder text. No real session was created or deleted.

The production-preview suite passes all **48 cases**, with retries disabled:

| Boundary | Desktop | Mobile |
| --- | ---: | ---: |
| Chat/report/slides, list-first and detail-first metadata | 6 | 6 |
| Failed detail lookup (404/503), blocked send, successful retry | 2 | 2 |
| Persisted Agent ID before Agent catalogue | 1 | 1 |
| Ready non-Agent chat retains ordinary report handoff | 1 | 1 |
| Chat/report/slides Agent model: pending inheritance, loaded inheritance, explicit session override | 9 | 9 |
| Late failure for A after navigation to loaded/pending B | 2 | 2 |
| New chat/report/slides creation | 3 | 3 |
| Total | 24 | 24 |

Held requests use explicit test-controlled promises rather than sleep-based timing. Both metadata sources can independently unlock the correctly typed composer. The navigation cases verify that a late failure for another ID cannot replace the current loading or ready state.

The first post-fix harness used Vite development mode: 4 cases passed and 14 reached an unexpected-WebSocket assertion because Vite HMR opened connections. The harness was changed to production preview while retaining the strict WebSocket block. Intermediate 28-case and 30-case production runs passed. The HMR failures are test-environment failures, not omitted product failures.

### Agent model inheritance follow-up

The first Agent fixture explicitly pinned its session model, which did not cover a newly created Agent session's empty-model inheritance. An additional 18 cases use different surface and Agent defaults. On the first fix (`37a175844d00804017e3533bc3a568de927568e6`), **14 passed and 4 failed**: report/slides with a pending Agent catalogue sent the surface default in `payload.model`, twice each across desktop/mobile. The API prioritizes that field over the Agent default.

The chat controls passed because ordinary chat already omits a turn model override and lets the server resolve it. The follow-up does not claim the same request-level defect in chat. For unresolved Agent inheritance, `send()` now retains an empty request model instead of substituting a surface default. The final assertions require the exact empty value for documents and an omitted override for chat; loaded Agent defaults and explicit session overrides retain their original behavior. All 48 cases pass after the follow-up. These are request-contract checks, not live Agent model execution proof.

## Other checks

- Web build and lint pass; existing bundle-size/lint warnings remain.
- The unchanged API suite passes: **2410 passed, 1 skipped, 11 warnings**.
- `git diff --check` passes.
- The existing slide presentation mock suite also passes all 18 cases on the first hydration fix's production bundle.
- A dedicated CI step runs the 48 hydration browser cases with its own build and preview server.

## Separate integrated API replay

A separate coordinator verified **one report refusal** using production UI and a real isolated API/PostgreSQL stack, with synthetic account/content and no mocked HTTP/SSE responses. This ran on combined candidate `f6641d3225233c12fa4581255f96da828c4d087b`, which contains the first hydration fix plus other open PRs. It is not a run of this standalone branch or the later Agent inheritance follow-up.

- The input's first visible placeholder was already the report placeholder; it did not first expose a chat placeholder.
- One message POST targeted the original report ID and received the existing freshness refusal (`409`); the draft remained visible and the persisted transcript remained empty.
- Forwarded model completions: **0**; account credit delta: **0**. Title generation was stubbed and automatic memory was disabled.
- The coordinator confirmed temporary database/network/files removal, closed API/preview ports, exited processes, and restored original runtime state.
- Evidence: `isolated-actual-browser-hydration-03.json` and `actual-browser-f6641d322523-report-hydration-fixed/{browser,api}.json` in the local QA evidence directory.

This replay confirms original report dispatch and refusal/draft handling only. It does not prove actual model generation, Agent catalogue/model inheritance, other session kinds, or broader authorization properties.

## Reproduction

From `apps/web`:

```sh
npm ci
npx playwright install chromium
npx playwright test --config playwright.session-hydration.config.ts --workers=1
```

The config owns port `5303` and refuses to reuse an existing server. All application API responses and streams are synthetic; unexpected requests are blocked, service workers are disabled, and WebSockets are blocked. No real application API, database, provider, or credential is used. These results do not establish live model output quality or complete application-wide browser coverage.

## Screenshots

The images are from the first 30-case mock production-preview run, with synthetic account data. The model-inheritance follow-up does not change these loading/retry states.

![Mobile loading state without a composer](screenshots/session-hydration-pending-mobile.png)

![Desktop failed lookup with a retry action](screenshots/session-hydration-retry-desktop.png)
