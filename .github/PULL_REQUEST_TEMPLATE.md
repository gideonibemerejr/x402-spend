<!--
Thank you for contributing to x402-spend.

Write for a reviewer who is familiar with TypeScript but may not know the
context behind this change. Keep the useful sections and remove prompts that do
not apply. A small pull request can have a small description.
-->

## Summary

<!-- What does this change? Prefer two or three concrete bullets. -->

-

## Motivation

<!--
What problem does this solve, and why is this approach worth taking?
Link the issue with `Closes #123` when applicable. Small fixes may not need one.
-->

## Approach

<!--
Explain the important implementation choices, tradeoffs, or alternatives.
Skip this section when the diff is self-explanatory.
-->

## Verification

<!-- List the exact commands and manual checks used to verify the change. -->

- [ ] `npm test` passes.
- Test coverage added or intentionally unchanged:

<!-- Paste concise output, reproduction steps, or before/after evidence when useful. -->

## Compatibility and risk

<!--
Write “None” where appropriate. Call out anything a package consumer or
maintainer should understand before merging.
-->

- Public API:
- Receipt schema or stored data:
- CLI or report output:
- x402 payment flow:
- Performance, privacy, or security:

## Documentation

<!-- Note README, JSDoc, examples, or migration guidance changed by this PR. -->

- Documentation updated or intentionally unchanged:

## Project guardrails

<!--
x402-spend is buyer-side instrumentation. It observes payments but does not
abort, recover, route, or enforce spend policy. Receipt fields are a persisted
contract. Concurrent calls—including calls to the same URL—must remain isolated.
The package currently has no runtime dependencies.
-->

- [ ] This change respects the project guardrails above, or proposes and explains an intentional change to them.

## Reviewer notes

<!-- Point reviewers to the riskiest code, open questions, or follow-up work. -->
