---
id: m3-login-front-door
tasks: [T11725, T11726, T11727, T11723]
kind: feat
summary: M3 — `cleo login` front door + models/roles wizard + inline OAuth onboarding + vapor-surface cleanup
---

Closes Milestone M3 of the Cleo Agentic Harness by wiring the user-facing onboarding surface over the already-merged core onboarding engine (`runOnboardingLogin`).

- **T11725** — top-level `cleo login` front door: a provider + auth-method picker that invokes the core 3-step onboarding engine inline (connect → select → bind → validate). `cleo auth login` and `cleo llm login` resolve to the SAME flow through a single shared handler (`runLoginFrontDoor`) and a single core orchestrator (`runFrontDoorLogin`) — no duplicated handler logic. Thin CLI handlers: parse flags → build `ReadlineWizardIO` → call the core engine → emit a LAFS envelope (`--json`/piped) or a human summary (TTY). A test asserts all three entry points dispatch to the same engine function.
- **T11726** — a `models-roles` wizard section (`createModelsRolesSection`) added after `llm` in the canonical order: pick a default model (`llm use`) and pin per-role profiles (`llm profile`) for the canonical role set, sourcing model choices from the catalog. Driveable non-interactively via `WizardOptions` (`defaultModel` + `roleBindings`).
- **T11727** — the wizard `llm` section OAuth path now runs the inline onboarding engine instead of printing "OAuth login deferred…"; `cleo init` emits a `cleo login` nextStep when the credential pool is empty and, on a TTY, an opt-in "Configure now?" prompt that launches the front door (non-TTY/`--json` only emit the nextStep).
- **T11723** — removed the dead `cleo llm bind --default` TSDoc reference in `LlmConfig` (replaced with the real `cleo config set llm.defaultProfile`); a test asserts every `cleo llm <verb>` referenced in config TSDoc resolves to a real `llm` subcommand.

The 5-entity Profile (provider/alias/account/model/profile) is addressable end-to-end: the login wizard creates a credential (Account) and binds a Profile (`llm.default` / `llm.roles[role]`), then validates the binding round-trips through `resolveLLMForSystem`.
