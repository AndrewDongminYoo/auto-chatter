# Mobile rule journey implementation

## Ownership and checks

Work in the existing checkout on `feat/355-mobile-rule-journey`; preserve untracked `PRODUCT.md`.
Own `public/app/{app.js,index.html,styles.css}`, `src/app/workspace-refresh.test.ts`, `scripts/mobile-rule-acceptance.mjs`, this plan, its specification and the affected dashboard invariants.
Use the existing runtime, tokens and form, without new dependencies.

## Steps

1. Reproduce the current mobile travel and overflowing navigation with a loopback synthetic API and Chromium viewport.
2. Add failing interaction regressions for preview switching, retained input focus and validation returning to composition.
3. Share the existing form and save action across the responsive editor and preview; retain desktop composition, expose account connection and avoid duplicate empty-list actions.
4. Add a synthetic browser fixture for compose/preview/revise/save, validation, dirty guard, failed save, busy controls and empty states; verify visible navigation at 320/390px and desktop in both themes.
5. Update the dashboard invariants and audit applicable README/CLAUDE/AGENTS claims for implementation-caused drift.
6. Run `corepack pnpm check-types`, `corepack pnpm test`, product lint (record the existing `.agents/` exclusion), full `trunk check --all --monitor=false`, and the affected browser fixtures.
7. Review the complete candidate, preserve screenshots and a visible review record, then request operator review of the working local preview before commits or PR publication.
8. After visual approval, commit scoped paths, publish the PR, finish current-head CI and hosted review, read back the live body, assign AndrewDongminYoo and proceed through authorized merge gates.

## Success and limits

Meet the specification's acceptance criteria with observed failing regressions followed by passing checks.
Keep state under the exact branch's Git-local PR-loop record and approval evidence in the surviving sibling `pr-loop-reviews/auto-chatter/issue355` directory.
Production behavior and full accessibility acceptance remain outside this task.
