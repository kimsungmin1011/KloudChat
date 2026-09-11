# Auto Badge Geometry Synchronization

This changes only the mock browser test and its CI configuration, not the product
layout or Auto selection policy. Baseline: `f53797251940ff6ddbc0d0eff657a1779664aa51`.

## Failure and Fix

The original two geometry cases passed with tracing enabled but failed four of
four production-preview trace-off repetitions: visibility succeeded and the next
`boundingBox()` returned null. DOM/React-key observation found the optimistic
message removed and replaced with the saved transcript about 31 ms later. The new
badge had valid bounds inside the 1440 px viewport. This is a measurement race,
not evidence of a product width regression.

The test now gates the transcript GET, proves its saved-question marker is absent
from the optimistic/SSE state, then releases the response and waits for that marker.
Only afterward does it locate the badge and run the original bounding-box, viewport
and document-width assertions. It adds no retry, arbitrary delay, skip or relaxed
geometry assertion. The gate is released in `finally` even if an assertion fails.

## Verification

- Same production trace-off pattern: four failures before, four passes after.
- Dedicated development-server configuration: 12 desktop/laptop cases passed,
  including both Auto modes, English labels and saved-history refresh.
- Configuration tests: four passed. Web lint/build passed with existing warnings.
- Owned server ports closed; no original database, account or provider was used.
- The focused mock configuration now runs in the existing web CI job. These tests
  do not establish live classifier accuracy, real cost savings or provider behavior.
