---
id: t11983-setup-wizard-e2e
tasks: [T11983]
kind: feat
summary: "cleo setup wizard e2e: fit-gated Ollama model picker, firstRunComplete flag, whoami summary + TUI offer after first-run, 16-test e2e TTY-simulated suite"
---

Closes the last batteries-included onboarding gap (T11983 / E6-ONBOARDING-FRONT-DOOR):
`cleo setup` now completes the full prefs → provider connect → model pick → profile →
validated round-trip → TUI offer flow in a single interactive session.

**Changes:**

- **`packages/core/src/setup/sections/models-roles.ts`** (modified):
  - New `_pickOllamaModelInteractive(io, ranker?)` export — when the active provider
    is `ollama`, calls `rankLocalModelFit` to detect hardware and rank 2–3 best-fit
    open-weight models. Below the 4 GB RAM floor, prints cloud-only guidance and
    returns `null` (RECOMMEND-NEVER-KILL: never auto-pulls, never auto-selects).
    Already-pulled models surface with a `[pulled]` annotation. Offers a manual-entry
    fallback so the user is never locked in to the ranked list.
  - Injectable `ranker` parameter keeps the function testable without OS/network calls.
  - `createModelsRolesSection().run()`: branches to `_pickOllamaModelInteractive` when
    the default provider is `ollama`; all other providers continue using the existing
    catalog-picker path.

- **`packages/cleo/src/cli/commands/setup.ts`** (modified):
  - `CleoSetupResult` gains `firstRunComplete: boolean` (mirrors
    `WizardRunResult.firstRunComplete`). Single-section runs always produce `false`;
    full-wizard runs produce `true` iff every section succeeded.
  - New `_printWhoamiSummaryAndOfferTui(io)` export — reads agent name, provider, and
    model from config then prints a `cleo whoami`-style summary to stderr after a
    successful first-run completion. Prompts the user to optionally launch `cleo tui`
    (fire-and-forget spawn, never blocks wizard exit).
  - `_readWhoamiSnapshot()` internal helper for best-effort config + credential pool
    reads (never throws).
  - Command `run()` calls `_printWhoamiSummaryAndOfferTui` after `cliOutput` when
    `result.ok && result.firstRunComplete`.

- **`packages/cleo/src/cli/commands/__tests__/setup-wizard-e2e.test.ts`** (new):
  - 16-test TTY-simulated e2e suite using `StubWizardIO` as the TTY simulation surface
    (the canonical CLEO approach — the wizard engine is I/O-agnostic by design).
  - Covers: full 10-section wizard pass with `firstRunComplete=true`; section-failure
    → `firstRunComplete=false`; single-`--section` always `false`; whoami summary
    content assertions; graceful non-TTY handling of the TUI offer.
  - Fit-gated Ollama path: below-floor cloud-only guidance, ranked recommendations,
    `[pulled]` annotation, skip/manual-entry/ranker-failure fallback paths.
  - `firstRunComplete` propagation verified for full and single-section runs.

**AC compliance:**

- Fresh-install `cleo setup` completes prefs → provider connect → model (fit-gated
  for Ollama, catalog for cloud) → profile → verification in canonical order.
- Reuses shipped building blocks: `llm` (T11725), `models-roles` (T11726),
  `models-roles` oauth-inline path (T11727), `cleo llm fit` envelope (T11982).
- Ends with whoami summary + TUI launch offer.
- E2E test with TTY-simulated (`StubWizardIO`) input: 16 tests all green.
