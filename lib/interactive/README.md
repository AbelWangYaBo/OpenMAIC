# Interactive runtime state

New interactive HTML declares an observation outlet inside the authored `#experiment` scope. The generator contract is in `packages/@openmaic/generation/snippets/interactive-observation.md`; the runtime schema is in `lib/interactive/observation.ts`.

The interface separates current object facts and relationships from the last completed rendering. A complete relationship set is exhaustive within its declared scope, including a known empty set. Unknown relationships establish neither presence nor absence. Missing information never falls back to source defaults or earlier snapshots.

The classroom references the whole authored scope and samples immediately before sending. The collector reads inert JSON; it does not execute activity getters or trigger rendering. Publication failures remove the previous outlet. Sampling is cancelled or invalidated on timeout, navigation, replacement and session disposal.

The existing static Host reference check runs before state validation. The route then checks source hash, scope, schema and freshness. Director and Child receive page-reported state separately from source definitions. Runtime object IDs are semantic evidence, not static selectors or tool targets. No additional tool permissions are granted.

## Local verification

No model calls are needed for these checks:

```sh
TEST_LOAD_LOCAL_ENV=0 pnpm exec vitest run tests/lib/interactive tests/lib/chat/pi/element-reference-route-l2.test.ts tests/generation/interactive-observation-contract.test.ts tests/generation/observation-lifecycle-example.test.ts --testTimeout=20000
pnpm exec playwright test interactive-observation-lifecycle.spec.ts interactive-state-reference.spec.ts
```

The browser tests use the repository's Playwright configuration. Classroom requests are intercepted. The synthetic classroom fixture exercises this sequence:

1. Pause rendering and change the current value from 1 to 10.
2. Reference the activity; the value and last rendering remain unchanged.
3. Change the current value to 0 after referencing, then send a question.
4. Verify the request contains current value 0 and last-rendered value 1.

## Boundaries

Whole-area references only; no precise internal picking, visual perception, persistent state service or component-specific adapters. Existing content without the interface retains its reference behavior and has unavailable runtime evidence.

The page authors the facts: validation cannot prove that it reported every relevant change truthfully. Source hashes associate the snapshot with content; they are not server signatures. A dedicated pooled-iframe switch-away/return race test remains a follow-up beyond the covered session lifecycle tests.

Live experiments and their original outputs are retained outside this PR. Their outcomes do not establish real-answer acceptance for this reduced implementation. Manual E2E and real-answer acceptance remain pending; keep the PR Draft.
