---
id: t12733-decide-profiles
tasks: [T12733]
kind: feat
summary: System One profiles (<provider>/<name>, several keys per provider, one active), a masked key prompt, human output on a terminal, and per-profile capability caching
---

**Profiles.** The decide credential store now holds any number of profiles,
addressed as `<provider>/<name>` (`layahost/work`, `layahost/personal`,
`jev/team`), each with its own key, and exactly one active profile that
everyday decisions use.

- `cleo decide config --provider layahost --key-stdin` stores `layahost/default`.
  `--profile <provider>/<name>` names another profile, `--url` overrides the
  provider's default URL (`--url default` restores it), and `--activate`
  switches to the profile. Adding a second profile never switches silently.
- `cleo decide use <provider>/<name>` switches the active profile.
  `cleo decide profiles [--probe]` lists them with the active one marked and
  keys masked. `cleo decide config --remove <p>/<n> [--use <p>/<n>]` removes
  one; the active profile needs `--use`.
- Every provider has a known default URL: layahost `https://layahost.com`,
  jev `https://api.typesafe.ai` (`JEV_DEFAULT_BASE_URL`, taken from the
  `system-one-integration` spec). A profile that keeps the default stores the
  literal `default`, resolved at call time, so a changed preset flows through.
- `resolveDecideProfile(name)` returns `{ name, profile, provider, baseUrl,
  apiKey, model }` for the benchmark; `listDecideProfiles()` enumerates them.
- The monthly spend ledger stays global across profiles.

**Downgrade-safe.** The file stays `version: 1`. Its top-level fields mirror
the active profile with the URL resolved, so v2026.9.23 reads the active
profile as its single config. When an older CLEO rewrites the file, its
top-level settings win for the active profile and `cleo decide profiles`
reports `reconciled: true`.

**Per-profile capability cache.** `provider-state.json` now maps each profile
to its detected capabilities, guarded by the key hash, so two layahost
accounts no longer overwrite each other's detection (one silently lost
batching and `cache:false`).

**UX.** The wizard asks provider → profile name (default `default`) → "Use
the default URL?" → key → model, saves, then asks whether to make the profile
active. The key prompt echoes one `•` per character. On a terminal,
`cleo decide config`, `status`, `ask`, `profiles` and `use` print a readable
block (the smoke test shows its question, answer, confidence, latency and
cost); `--json` or a pipe keeps the envelope. `cleo decide ask` takes
`--question` (`--noul` stays as an alias). Running `decide`, `login` or
`setup` outside a project no longer prints the T310 "Not inside a CLEO
project" WARN line.
