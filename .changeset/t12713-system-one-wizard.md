---
id: t12713-system-one-wizard
tasks: [T12713, T12714]
kind: feat
summary: System One setup wizard with provider presets (layahost by default, jev for a custom URL), an always-stored model, and hidden API-key input in every wizard
---

**Provider presets (T12713).** `cleo decide config` now takes
`--provider layahost|jev`:

- `layahost` is the default and the recommended choice. It uses the fixed URL
  `https://layahost.com` and the model `laya-auto`, so the user brings only an
  API key: `printf %s "$KEY" | cleo decide config --provider layahost --key-stdin`.
  `--url` still overrides the URL.
- `jev` is any Jev-compatible endpoint. It requires `--url`, and without one
  the command fails with a clear error. The model comes from `GET /v1/models`.

The contracts gain `DecisionProviderKind`, `LAYAHOST_BASE_URL` and
`LAYAHOST_DEFAULT_MODEL`, and the presets live in `core/src/decide/providers.ts`.

**Always a model.** Before this change, a config whose model lookup failed was
stored without a model. layahost then answered every decision with 422 and
every site fell back silently. A layahost config now always stores
`laya-auto` when no model is given. Only a `jev` endpoint whose listing fails
can end without one, and that case still warns.

**Active immediately.** After saving, `configureDecide` probes the provider and
re-detects its capabilities even when the cached read is fresh. The provider's
extensions (batch, usage, cache control) therefore apply at once, and the
result reports `providerState` and `capabilities`.

**Credentials v2.** `decide-credentials.json` records the provider kind. A v1
file loads as `jev` and is rewritten as v2 on the next save. The 0600 file, the
lock and the rule that allows plain http only for loopback are unchanged.

**Wizard.** `cleo decide config` with no flags on a terminal runs
`runDecideWizard`. Without a terminal it shows the current settings, as
before. The wizard steps are:

1. pick the provider (layahost first);
2. for jev, enter the URL;
3. enter the API key (hidden);
4. probe `/v1/models`;
5. pick the model (laya-auto first for layahost);
6. optionally confirm a one-question smoke test;
7. save.

`cleo setup` gains an optional `system-one` section after `llm`, which runs
the same wizard.

**Hidden key input (T12714).** `WizardIO` gains `secret(question)`. The CLI
implementation mutes the output stream readline echoes into, so the characters
of a typed or pasted key never reach the terminal. The `llm` setup section,
the `cleo login` API-key prompt and the System One wizard now use it. The
`llm` prompt had previously claimed its input was not echoed when it was.
