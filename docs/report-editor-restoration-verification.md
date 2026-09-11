# Report Edit Restoration Verification

## Defect and Fix

- Base: `f53797251940ff6ddbc0d0eff657a1779664aa51` (upstream main).
- A header row changed from on to off and back to on looked restored, but saving and reloading retained the intermediate off state.
- Editing the document title or section heading from A to B to A similarly saved B.
- The section editor now compares against its last emitted serialization, not only its initial content. Title and heading editors receive and compare their latest accepted value.
- Initial normalization, duplicate updates, empty values and cancelled edits remain guarded. No API, model, routing or billing changes.

## Reproduction and Verification

- Three completed baseline interaction failures establish the defects. Earlier fixture setup errors are not product evidence.
- `npx playwright test --config playwright.report-table.config.ts --workers=1`: 12 passed against a production build on the standalone main-based branch. The suite is also wired into CI.
- Coverage: header restoration at 1440/390 px, no phantom save, undo/redo, rectangular merge/split, full-width vertical merge reload, title/heading restoration, empty and cancelled edit controls.
- Browser saves and reloads assert the exact synthetic PATCH payload and rendered table. Authentication and API transport are fail-closed mocks; this does not prove live database durability.
- `npm run lint`: passed with the existing 196 warnings. Build/typecheck and four Playwright configuration tests passed. The upstream CSS optimizer warnings remain here; their separate fix is PR #186.
- Actual desktop/mobile screenshots are in `docs/screenshots/report-header-restored-*.png`. They show the existing scrollable A4 surface, not a mobile-layout redesign.
- No actual model calls or user-data access. The owned preview server on port 5201 exits after tests.

## Separate Scope

Merged rows lost during downloaded DOCX/HWPX/PDF export are a separate API issue. This PR verifies browser editing and serialized save/reload, not that export correction. Full combined API results from other branches must not be attributed to this standalone Web-only change.
