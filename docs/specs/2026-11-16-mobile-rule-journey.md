# Mobile comment rule journey

Issue: [#355](https://github.com/AndrewDongminYoo/auto-chatter/issues/355), following #352–#354 under #351.

## Problem and scope

At 390px the existing navigation measures 445px inside a 350px viewport, and the preview heading lies about 577px after the first message input in the empty-rule fixture.
The rule list, long form, save action and preview require repeated scrolling.
Connect composition, preview, revision and saving without replacing the existing form or its validation.

## Interaction

Keep the desktop editor and conversation preview side by side.
At mobile widths, use a shared sticky save bar and a button that switches between the existing fields and the live preview.
Switching preserves the same input nodes, values and dirty state; returning restores the last focused input, while invalid submission exposes the fields before native validation focuses them.
Keep the current save action, busy lock, inline error and saved-state messages, with the shared send-settings explanation visible in either mode.
Show account connection first when no account exists; hide the unavailable editor and empty rule-list duplication.
When no rule exists but an account does, show the new editor directly; retain the list and new-rule action once saved rules exist.
Let mobile navigation wrap so every permitted menu is visible without horizontal scrolling.

## Alternatives and assumptions

A collapsible preview would still require travel through the long input section; a dialog adds an unnecessary focus boundary.
Use the existing visual design and a mobile mode switch with a common save action as the conservative default within the requested issue.
The operator may review the working local preview before any commit or PR.
Oracle's `wiki/concepts/auto-chatter-contact-csv-preview-session-isolation.md` supports checking both visible output and retained draft state; its indexed source freshness is unverified and it supplies no mobile layout decision.

## Acceptance

- At 320px, 390px and desktop, compose, preview, revise and save without resetting inputs, including follow confirmation buttons and both follow branches.
- Preview return restores input focus; invalid submission reveals and focuses the invalid field; a missing media selection remains actionable.
- Failed saves preserve input and dirty status, display the existing recovery message, and retain a usable save action; successful saves produce one write and show the saved state.
- Preview toggles produce no API writes and do not bypass discard warnings; saving locks the fields and preview control.
- All permitted navigation links remain visible and keyboard reachable without horizontal page or navigation overflow in light and dark modes.
- Synthetic browser evidence covers no account, no rules, editing, validation, failed save and saved state; preserve existing session and workspace regression coverage.

## Boundaries

No backend, API, send-policy, framework, dependency or flow-editor redesign.
No production deployment, provider account access or real messages.
Chromium viewport checks do not prove physical-device keyboard or Safari behavior; full accessibility acceptance remains #63.
