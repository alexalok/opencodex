# PR 38 GUI evidence

Source: alexalok/opencodex commit c3463b4892edb3e88d82ed4833256107077c00f1.

Real Chromium screenshot of QuotaSummaryChips and QuotaBars imported directly from the merged GUI, using built production CSS. The isolated browser fixture follows gui/tests/quota-summary-hover-browser.ts and uses synthetic Mistral data from gui/tests/mistral-budget-display.test.tsx: EUR 12.50 of EUR 50.00 API budget (25%), TEAM plan, and unknown Vibe entitlement. This is component-level visual evidence, not a live dashboard or end-to-end API test. No credentials or user account data were loaded. Browser processes were stopped after capture.

GUI validation: bun install --frozen-lockfile; bun run build (passed).

## Codex CLI update panel

Source commit 7126f84c50c4f84a086156c39503aacef5364648. Real Chromium rendering of the merged CodexCliUpdate component with production CSS. The plan response uses synthetic values from gui/tests/codex-cli-update-panel.test.tsx. Only the read-only Check action was exercised against the mocked fetch function. Apply was not clicked and no installation was changed. The screenshot shows the unchecked confirmation and disabled update button.
