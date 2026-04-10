# T484 CLI Runtime Verification: Tools Domain

**Date**: 2026-04-10
**Domain**: tools (skills, provider, adapter, issue)
**CLEO version**: 2026.2.1 (runtime) / 2026.4.25 (CLI help strings)

---

## 1. Skills Commands

### 1.1 `cleo skills list`
- **Exit**: 0 — PASS
- Returns 21 installed skills from `/home/keatonhoskins/.local/share/agents/skills/`
- Operation name in meta: `tools.skill.list`
- `count`, `total`, `filtered` all correctly set to 21

### 1.2 `cleo skills search "cleo"`
- **Exit**: 0 — PASS
- Returns 8 matching skills
- **BUG / MISLEADING**: operation name in meta is `tools.skill.list`, not `tools.skill.find` or `tools.skill.search`. The `data.count` and `data.query` fields are correct but the `meta.operation` does not reflect the actual operation performed. This diverges from the pattern used by other domains.

### 1.3 `cleo skills discover`
- **Exit**: 0 — PASS
- Returns all 21 skills (same result as `skills list`). No functional distinction is visible in the output — discover returns the full list exactly as list does. This may be intentional (cache refresh + return) but is not documented in the help text.

### 1.4 `cleo skills info ct-cleo`
- **Exit**: 0 — PASS
- Returns single skill record. Operation: `tools.skill.show`

### 1.5 `cleo skills validate ct-cleo`
- **Exit**: 0 (exit code) — PASS on exit code
- **BUG / RUNTIME ERROR**: Returns `E_INTERNAL` with message "No skill library registered. Register one with `registerSkillLibraryFromPath()` or set the `CAAMP_SKILL_LIBRARY` environment variable." This is a hard failure for the validate command. Despite the error payload, the process exits 0. The operation resolves as `tools.skill.verify`.
- **Severity**: Medium — validate is a user-visible command that fails silently (exit 0 despite error body)

### 1.6 `cleo skills install --help`
- **Exit**: 0 — PASS
- Shows: install skill to agent directory, supports `--global` flag

### 1.7 `cleo skills uninstall --help`
- **Exit**: 0 — PASS
- Shows: uninstall a skill; no options listed (no `--global` flag mirror for uninstall vs install)

### 1.8 `cleo skills enable --help`
- **Exit**: 0 — PASS
- Description: "Enable a skill (alias for install)"
- **Finding**: `enable` is explicitly an alias for `install`. No additional behavior.

### 1.9 `cleo skills disable --help`
- **Exit**: 0 — PASS
- Description: "Disable a skill (alias for uninstall)"
- **Finding**: `disable` is explicitly an alias for `uninstall`. No additional behavior.

### 1.10 `cleo skills refresh`
- **Exit**: 0 — PASS
- Returns `{updated: [], failed: [], checked: 1}` — only 1 item checked. This seems low given 21 installed skills. Likely only checks a cache file or registry entry, not individual skill files.
- **Finding**: The `checked: 1` value warrants investigation — does this reflect a known limitation or a bug in the refresh scan?

### 1.11 `cleo skills dispatch ct-cleo`
- **Exit**: 1 — FAIL
- Same `E_INTERNAL` error as validate: "No skill library registered."
- Operation: `tools.skill.dispatch`
- **Severity**: High — dispatch is the mechanism by which orchestrators route skills to agents. A hard failure here means no programmatic skill routing works in this environment.

### 1.12 `cleo skills catalog`
- **Exit**: 0 — PASS
- Returns `{available: false, version: null, libraryRoot: null, skillCount: 0, protocolCount: 0, profileCount: 0}`
- **Finding**: CAAMP catalog is not available/configured in this environment. The command succeeds but reports no catalog. Help text says "Browse CAAMP skill catalog (protocols, profiles, resources, info)". This is an environment gap, not a CLI bug.

### 1.13 `cleo skills precedence`
- **Exit**: 0 — PASS
- Returns full precedence map for 45 providers. Well-structured output with `providerId`, `toolName`, `precedence` classification, and per-provider global/project skill paths.

### 1.14 `cleo skills deps ct-cleo`
- **Exit**: 1 — FAIL
- Same `E_INTERNAL` error: "No skill library registered."
- Operation: `tools.skill.dependencies`
- **Severity**: Medium — dependency inspection is blocked in this environment

### 1.15 `cleo skills spawn-providers`
- **Exit**: 0 — PASS
- Returns 5 providers that support `supportsSubagents=true`: `claude-code`, `codex`, `gemini-cli`, `opencode`, `pi`
- Full capability metadata per provider including MCP config, hooks, spawn mechanisms. Rich and useful output.

---

## 2. Provider Commands

### 2.1 `cleo provider list`
- **Exit**: 0 — PASS
- Returns 45 total providers, 34 with `status: active`. All major AI coding tools catalogued.

### 2.2 `cleo provider detect`
- **Exit**: 0 — PASS
- `detected: ""` (empty string), `count: 45`
- **BUG / UX**: `detected` is an empty string when no single provider is detected as active. This should either be `null` or the field should be omitted. An empty string is confusing — it implies detection ran but found no active provider. The `count` of 45 refers to the total registered providers, not the detected count, making the response shape inconsistent with `adapter detect` (which returns `detected: [], count: 0`).

### 2.3 `cleo provider inject-status`
- **Exit**: 0 — PASS
- Returns 3 injection checks: `CLAUDE.md` (claude-code), `AGENTS.md` (cursor), `GEMINI.md` (gemini-cli) — all `status: current`, all files exist.

### 2.4 `cleo provider supports --help`
- **Exit**: 0 — PASS
- Args: `<PROVIDER-ID> <CAPABILITY>` — correct shape for capability queries like `spawn.supportsSubagents`

### 2.5 `cleo provider hooks --help`
- **Exit**: 0 — PASS
- Args: `<EVENT>` — filter providers by hook support

### 2.6 `cleo provider inject --help`
- **Exit**: 0 — PASS
- Options: `--scope` (project/global), `--references`, `--content`

---

## 3. Adapter Commands

### 3.1 `cleo adapter list`
- **Exit**: 0 — PASS
- `{count: 0, adapters: []}` — no adapters registered/loaded

### 3.2 `cleo adapter detect`
- **Exit**: 0 — PASS
- `{detected: [], count: 0}` — no adapters detected (correct use of empty array vs empty string)

### 3.3 `cleo adapter health`
- **Exit**: 0 — PASS
- `{adapters: [], count: 0}` — no adapters, no health entries

### 3.4 `cleo adapter show --help`
- **Exit**: 0 — PASS
- Args: `<ADAPTER-ID>`

### 3.5 `cleo adapter activate --help`
- **Exit**: 0 — PASS
- Args: `<ADAPTER-ID>`

### 3.6 `cleo adapter dispose --help`
- **Exit**: 0 — PASS
- Options: `--id` (specific adapter to dispose, omit for all)

---

## 4. Issue Commands

### 4.1 `cleo issue diagnostics`
- **Exit**: 0 — PASS
- Returns environment snapshot: cleo version `2026.2.1`, node `v24.13.1`, OS `linux 6.19.8-200.fc43.x86_64 x64`, arch `x64`, shell `/bin/bash`, cleoHome, gh version, installLocation
- No issues reported (no `issues` array, no `summary` object)
- **Finding**: The `data` shape is flat diagnostics info, not structured as `{issues, summary}`. The parsed `issueCount` comes up 0 because there is no `issues` key. This is a shape difference from what you might expect from a command named `diagnostics`. Output is useful as an env snapshot but does not indicate whether any configuration problems were detected.

---

## 5. Analysis: Alias vs Functional Duplicates

### `cleo skills enable` vs `cleo skills install`

**Verdict: Intentional aliases, not duplicates.**

The help text for `enable` explicitly states "(alias for install)" and the CLI help for the `skills` group lists both separately. They share identical argument signatures (`<SKILL-NAME>`, `--global`). This is a UX affordance for discoverability — `enable`/`disable` vocabulary is more natural for users thinking of skills as toggleable features, while `install`/`uninstall` vocabulary is more natural for users thinking in package-manager terms.

No redundancy issue: the pair is documented, intentional, and coherent.

### `cleo skills disable` vs `cleo skills uninstall`

**Verdict: Intentional aliases, not duplicates.** Same reasoning as above.

**One gap**: `skills install --help` shows `--global`, but `skills uninstall --help` shows no options at all. If `--global` install is possible, `--global` uninstall should also be possible. This asymmetry could cause confusion.

---

## 6. Analysis: `cleo provider` vs `cleo adapter`

**Verdict: Distinct concerns, but the boundary is unclear to a new user.**

| Dimension | `cleo provider` | `cleo adapter` |
|-----------|----------------|----------------|
| Purpose | Static registry of AI tool metadata (CAAMP) | Runtime instances of loaded/active providers |
| Data source | Hard-coded capability registry (45 entries) | Runtime adapter pool (0 entries when none loaded) |
| Mutating ops | `inject` (writes AGENTS.md) | `activate`, `dispose` |
| Detection | `detect` returns active provider ID | `detect` returns loaded adapter instances |
| Health | Not applicable | `health` returns per-adapter status |

The distinction maps to configuration-time vs runtime:
- `provider` is the registry/catalogue layer — "what providers exist and what are their capabilities"
- `adapter` is the runtime/lifecycle layer — "what provider instances are currently active in this session"

**Gap**: `provider detect` and `adapter detect` are confusingly named for the same verb. `provider detect` returns which provider CLI is in use based on environment heuristics; `adapter detect` returns which adapters have been loaded at runtime. The output shapes differ (`detected: ""` string vs `detected: []` array), which makes the inconsistency more jarring.

**Recommendation**: Rename or re-describe one of these to reduce collision. `provider detect` could become `provider identify` or `provider active` to distinguish it from the adapter lifecycle sense of "detected."

---

## 7. Failures Summary

| Command | Exit | Error | Severity |
|---------|------|-------|----------|
| `skills validate ct-cleo` | 0 | E_INTERNAL: No skill library registered | Medium |
| `skills dispatch ct-cleo` | 1 | E_INTERNAL: No skill library registered | High |
| `skills deps ct-cleo` | 1 | E_INTERNAL: No skill library registered | Medium |

All three failures share the same root cause: `CAAMP_SKILL_LIBRARY` env var is not set and no library has been registered via `registerSkillLibraryFromPath()`. Commands that require the library (validate, dispatch, deps) fail. Commands that work from the installed-skills directory directly (list, search, info, discover) succeed.

---

## 8. Minor Findings

| Item | Description |
|------|-------------|
| `skills search` meta operation | Reports `tools.skill.list` instead of `tools.skill.search` or `tools.skill.find` |
| `skills discover` vs `skills list` | Functionally identical output observed; no distinction visible |
| `skills refresh` checked: 1 | Only 1 item checked despite 21 installed skills |
| `skills catalog` available: false | CAAMP catalog not configured; environment gap, not a CLI bug |
| `provider detect` empty string | `detected: ""` should be `null` or omitted for consistency |
| `uninstall` missing `--global` | Asymmetry with `install --global` flag |
| `issue diagnostics` flat shape | No `issues[]` or `summary{}` keys — just env info |
