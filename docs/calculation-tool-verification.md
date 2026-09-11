# Calculation tool verification

## Scope

Issue #178 covers ordinary chat requests with clearly supplied numeric arithmetic.
KloudChat already has a bounded, Fraction-based calculator and an explicit NCS
verification skill. This change addresses skipped verification, not a missing
calculator, and does not close the broader NCS quality issue #142.

- Recognized arithmetic requires a permitted, read-only built-in calculator before
  answer text is released. Agent allowlists and tool-support requirements remain
  authoritative; an unavailable calculator returns an actionable HTTP 409.
- A single literal expression supplied by the user can be copied to the calculator
  after bounded AST validation. The server neither evaluates it nor invents a
  word-problem equation. For other recognized requests the model supplies the
  expression, while a successful arithmetic tool result gates the answer.
- Initially the required first stage exposed only the required tool schema. The
  prerequisite-read follow-up below allows permitted reads for missing operands
  in ordinary non-literal calculations while retaining mandatory verification. General
  arithmetic can verify multiple expressions; the existing NCS gate remains
  exclusive. Successful duplicate calls reuse per-turn evidence without executing
  the same calculation again. Failed calls do not unlock the answer.
- Ignoring named `tool_choice` receives one bounded protocol reminder. Unverified
  draft text is discarded; a second refusal to call the tool results in a hold.
  Tool-hop limits and unrelated tool permissions are unchanged.
- Auto economy keeps the tool-capable quality model for these requests and shows
  the reason in both streamed and saved messages. Auto quality retains its existing
  classifier and model-selection behavior.
- One explicit previous-result operation can continue a completed arithmetic
  chain, for example adding a number or taking a percentage. The bounded check
  uses only privacy-processed text from at most eight contiguous same-session
  question/answer pairs, with a bare numeric or numeric-equation answer shape.
  It rejects attachments, variants, artifacts, failed turns and non-model answers.
  This shape check does not certify the previous answer's arithmetic correctness;
  the model still supplies the new equation to an already-permitted calculator.

Dates, version strings, code creation, translation, editing commands, explicitly
missing inputs and declined calculation have negative regression cases. This is
a conservative request classifier, not a general semantic guarantee. Attachments
without an explicit request, general anaphoric follow-ups, prose-only previous
answers, spelled-out numbers and inputs over the bound remain outside the
required-calculation policy. Compare and document routes are not covered by this
ordinary-chat gate.

## Verification

The API suite ran with real socket connections and HTTPX network transports denied.
UI tests use synthetic API/SSE responses and a real Chromium page, not a live model.

| Check | Result |
| --- | --- |
| Main `2518c2e` API baseline | 2,410 passed, 1 skipped |
| Candidate `412c77d` API suite | 2,653 passed, 1 skipped |
| New API regressions | 243 cases, including required schema, routing, literal extraction, repair and deduplication |
| Browser regressions | 6 passed: refusal on desktop/mobile; Auto reason on saved/streamed desktop/mobile |
| Web lint/build | Passed; pre-existing lint, CSS selector and chunk-size warnings remain |

An isolated temporary database and local API also exercised three unchanged
synthetic questions against the configured `strict-local/qwen3.6-35b` route.
The catalogue reports this route as zero-credit and tool-capable. This does not
attest the provider's physical execution location. Title generation was explicitly
stubbed and automatic memory disabled in this bounded harness.

| Question | Main `2518c2e` | Candidate `412c77d` |
| --- | --- | --- |
| `17 * 23` | Correct 391, calculator skipped | Correct 391, one successful calculator execution |
| 12 people averaging 70 and 8 averaging 95 | Correct weighted average 80 and grading | Correct weighted average 80 and grading; one successful calculation |
| Increase from 80 to 100 | Correct 25% and grading; failed call then recovery | Correct 25% and grading; failed call then recovery |

Each three-case run used 6 completion requests, consumed 0 reported credits and
created 0 artifacts. Candidate execution made 4 calculator calls: 3 successful and
1 invalid call. Temporary database, network, credentials and files were removed,
ports closed, and the original database state and stopped status restored.
The gateway boundary was an application transport allowlist, not an OS firewall.

Earlier candidates held one otherwise answerable question because Qwen ignored
the required tool call. These were usability failures, not correct answers.
The final three-case run did not exercise the ignored-call repair; that branch is
covered by deterministic regressions. Repeated stochastic runs do not isolate a
causal accuracy gain, and three correct numeric outcomes do not establish a general
accuracy rate or complete explanation quality.

The tested API was subsequently rebased onto `f537972`; the only additional API
change from upstream was its unrelated default monthly-credit setting. Evidence
must be associated with the recorded source SHA, not presented as a release test.

## Follow-up verification

The follow-up source `d84245fb83213e423e781a6e7b71c31690bb0073` also
distinguishes a calculator-authored failure from a model-generated answer.
Only a literal expression copied from the user, the actual built-in calculator,
its typed division-by-zero result, and no attempted answer-model request qualify.
Model-composed expressions and other tool failures retain the existing retry/hold
behavior. Malformed expressions and choices are validated before the typed result.

The fixed answer has `answerOrigin=tool_result`, `model=null`, zero answer usage,
and no answer charge or title/memory/artifact enrichment. Privacy metadata and any
earlier search ledger or Auto classifier audit are preserved. Model selection,
headroom/key preparation, and Auto quality classification can precede the answer;
this is not a promise of zero upstream work or zero whole-turn cost in every mode.

| Actual manual-route replay | Answer origin | Answer completions |
| --- | --- | --- |
| `12 / 0` with a brief-answer instruction | Calculator explains division by zero; persisted model null | 0 |
| `12 / (3 - 3)` with the same instruction | Calculator explains division by zero; persisted model null | 0 |
| `12 / 3` normal control | Qwen answers `12 / 3 = 4` after calculator execution | 1 |

This three-case run made three calculator dispatches (two expected arithmetic
failures and one success), one completion, zero reported credits and zero artifacts.
Stored failure answers have an empty `actualModels` list. All temporary resources
were removed and the original read-only source data/stopped database preserved.
The earlier `86aadbf` run failed the two provenance expectations: the literal
extractor did not recognize the benign Korean brief-answer suffix, so it called
the model and held generically. Four real `send_message` regressions reproduced
that failure before the suffix fix; the same live questions were then replayed.

Uncustomized ordinary chat now omits the built-in NCS checker unless the current
or retained user request explicitly needs NCS/quiz grading. All Agent, project,
skill, attachment and other custom contexts preserve their existing tool selection.
The calculator is retained, the catalogue is unchanged, and no excluded permission
is added. Missing-data prompts do not receive invented equations or forced tools.

A separate paired five-question run compared `b930a520` and `56db6ca8`: three
missing-data requests, one explicit NCS control and one literal multiplication.
Both versions gave correct core limitations/calculations; each made six completion
requests and two successful calculations with zero reported credits/artifacts.
The baseline exposed checker protocol in two responses (three fully satisfactory
answers); the candidate removed that protocol but one response was unnecessarily
long and added unverified conditional examples (four fully satisfactory answers).
Those examples were numerically correct, but are a remaining quality limitation.
One stochastic observation per prompt is not a general accuracy estimate or causal
proof that removing a schema alone improved prose.

Follow-up regression results: **2,783 API passed, 1 skipped**, real network blocked;
**12 mock-browser cases passed**, including saved/streamed/buffered tool provenance,
normal model-answer control, mobile geometry and retained privacy badges. Web
build/lint and four configuration tests passed. Existing CSS selector warnings
are addressed independently by PR #186, not silently included in this PR.

## Notation and explicit refusal follow-up

Source `b18e39bf5213f4f1150219424c4c9b4ef47ed2b6` adds 57 regression
cases and closes three request interpretation boundaries without adding tools or
changing model permissions:

- NFKC previously copied `2² + 3²` as `22 + 32` and `10⁻² + 1` as
  `10-2 + 1`. Non-positional numeric notation now bypasses direct literal copying.
  The original request reaches the existing model-directed calculator path;
  supported fullwidth positional digits and multiplication/division/minus symbols
  retain their existing conversions. The server does not translate powers into
  an invented expression.
- Explicit Korean negative operations and the supported English negative
  arithmetic verbs no longer force an unnecessary tool requirement or a 409 on
  a tool-free model. An explicit replacement or separate later calculation still
  uses the existing arithmetic gate.
- Word apostrophes no longer join separate `Don't` instructions into a quoted
  span that erases their refusals. A linear quote masker retains Korean suffixes,
  true quoted commands, newline boundaries and the complete request suffix.

Top-level `send_message` tests fail before the corresponding fixes, including
the wrong copied expression and unnecessary 409. Final offline API: **2,840
passed, 1 skipped**, 11 existing warnings, 82 socket attempts blocked and zero
external HTTP attempts. Ruff and diff checks passed. The unchanged Web source
retains the previously recorded browser results; they are not a new browser run.
The quote comparison covers 4,096 combinations within one differential test,
not 4,096 extra API test cases.

| Actual Qwen request | Verified successful calculator expression | Final response |
| --- | --- | --- |
| `2² + 3²` | `2*2 + 3*3` | `13` |
| `10⁻² + 1` | `1/100 + 1` | `1.01` |
| Fullwidth `１２ ÷ ３` | `12 / 3` | `4` |
| Repeat `5` and `9` without addition | No calculator call | `5 9` |

The four synthetic manual-route requests completed with eight completion
requests, five calculator dispatches (three successful and two initial failures),
zero reported credits and zero artifacts. Both superscript cases first produced
an invalid calculator call, then recovered within the existing tool loop. The
sanitized evidence does not retain those failed expressions, so their exact
syntax is not inferred. Successful expressions, final answers, original data and
stopped-state preservation, frozen source and complete temporary cleanup were
checked separately. This was not a paired live baseline experiment or proof that
all Unicode math is handled. Mixed fractions and some other unsupported notation
remain outside the pre-existing required-calculation predicate.

## Previous-result calculation follow-up

Source `9fcb7c727e64d978ec122081772334e9b753b69b` extends the existing
gate to one explicit operation on a completed previous numeric result. It does
not copy a prior answer into a server-invented equation: the unchanged,
privacy-processed conversation reaches the model, which supplies the next
expression to an already-permitted calculator. Eight-pair history bounds,
negative intent, retry trimming and missing-tool refusal have regressions.

Before the change, the real `send_message` routing regression had **18 failed,
18 passed** on the prior source. The final independent read-only verification
ran **421 calculation tests passed**, with zero socket/HTTP attempts, and
**2,947 API tests passed, 1 skipped**, with 11 existing warnings, 82 socket
attempts blocked and zero HTTP attempts. Ruff passed. These are offline results
for the recorded source, not additional live-model test cases or new Web runs.

An isolated actual-model replay used the same four-turn synthetic conversation
on baseline `43d94a1c05412e4f2f5af6afbf974ae4d268c9b5` and the candidate,
selecting `strict-local/qwen3.6-35b` in manual mode:

| Turn | Baseline | Candidate |
| --- | --- | --- |
| `25 * 16` | Correct 400; one calculation | Correct 400; `25 * 16` verified |
| Add 25 to that result | Correct 425; calculator skipped | Correct 425; `400 + 25` verified |
| Take 20% of that total | Correct 85; calculator skipped | Correct 85; `425 * 0.2` verified |
| Switch to describing Python lists | Relevant answer; no calculation | Relevant answer; no calculation |

The baseline already had three correct numeric answers. The observed improvement
was **calculator executions 1 to 3 and missed follow-up calculations 2 to 0**, not
numeric accuracy. Completion requests increased **4 to 8**. On both candidate
follow-ups Qwen first ignored the required tool choice; the existing one-reminder
repair then elicited a successful calculation. This is not first-attempt tool
compliance. The final percentage answer correctly stated that 20% of 425 is 85,
but omitted the explicitly requested multiplication equation, a remaining format
defect despite successful tool use.

All four candidate SSE answers matched the stored text. Both runs reported zero
app credits and zero artifacts. Candidate receipt, original report and assessment
were independently checked: source stayed frozen and clean, temporary database,
network and files were removed, API process exited and ports closed, and original
read-only data and stopped database state were preserved. The harness explicitly
stubbed title generation and disabled memory; its HTTPX transport allowlist is
not an OS firewall or physical-locality attestation. One fixed chain does not
establish general accuracy, prior-answer truth, or model-only causal improvement.

## Read-before-calculation follow-up

Source `d788dea396398673d307ecdb04fe39a2f285e77c` restores a missing tool
dependency: an Agent or selected Skill may need to retrieve quantities before it
can form an arithmetic expression. Previously the calculator-only first schema
hid already-permitted retrieval tools, even when the necessary source was present.

For ordinary required calculations without a literal or trusted preset, the
caller-provided, allowed tools classified as read-only may precede calculation.
They cannot satisfy the arithmetic gate. A mixed dependent read/calculation batch,
failed or empty read, and an attempted answer before verified calculation are
held. A read's terminal text cannot unlock a numeric answer. After calculation
starts, its existing exclusive verification/repair path remains. Literal, NCS,
trusted search presets, permissions, privacy snapshots and tool-hop limits remain.
MCP blank responses and knowledge no-result responses preserve their empty flag.

The new 22 cases reproduce 12 failures and 10 passes before the change, then all
pass. Standalone offline API: 2,969 passed and one existing skip; focused agent/tool
suite: 719 passed; Ruff passed. Independent 25-case verification includes parallel
reads before calculation, failed-calculator read reentry refusal and sanitization.
The integrated existing freshness/calculation plus new controls pass 76 cases.

An actual API replay used the same synthetic Agent Markdown (product 101 has 7
units, product 102 has 9), questions and callback on frozen baseline `f442f385`
and integrated candidate `2633d4f7`:

| Case | Baseline | Candidate |
| --- | --- | --- |
| Retrieve quantities and total them | No retrieval; invalid expression then irrelevant `0+0`; final answer falsely said no data was provided | `search_knowledge` then `calculate(7+9)`, final equation and 16 units correct |
| Literal `12 / 3` | Calculator once, correct 4, no read | Calculator once, correct 4, no read |
| Agent without calculator permission | 409, empty transcript, no model/tool | Same refusal contract |

Baseline six and candidate four completion attempts are for these three fixed
cases, not an accuracy denominator. Candidate has one successful read and two
successful calculators, no repair or tool failure; both runs measured zero app
credit delta. Stored and streamed text/IDs agree, synthetic source extraction was
checked, no remote MCP/vector index was used, and temporary resources/original
data/source SHA were preserved. Actual tools ran through the authenticated API;
this was not a UI test or a physical-locality/provider-cost attestation.

The runtime uses the existing configured `read_only` contract, not independent
proof of what a connector does. It does not introduce a new effect classification
or permission grant. Ordinary word problems may now expose permitted reads even
when the model does not need them; the model must still select appropriately.
Two sequential lookup hops leave no room for calculation under a two-hop limit
and therefore cannot produce a verified answer. A successful calculator still
does not prove that its operands came from the right source or answer every NCS
reasoning requirement. These bounded checks are not a general accuracy estimate.

## Remaining limits

A calculator proves arithmetic on its supplied expression. It does not prove that
the expression matches every condition in a word problem, that a selected option
has the right meaning, or that the final model explanation faithfully uses the tool
result. In particular, an incorrect student's reasoning cannot be inferred merely
from their selected answer. These limits remain part of #142 rather than being
counted as solved by the tool-use gate.

## UI evidence

The screenshots show synthetic mock-browser verification, not provider execution.

![Unavailable calculator on desktop](screenshots/calculation-refusal-desktop.png)

![Auto calculation reason on mobile](screenshots/auto-calculation-reason-mobile.png)

![Calculator-authored error on desktop](screenshots/calculator-answer-streamed-desktop.png)

![Calculator-authored error on mobile](screenshots/calculator-answer-streamed-mobile.png)
