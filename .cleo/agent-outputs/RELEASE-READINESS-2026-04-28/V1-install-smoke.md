# V1 Validation Report — Fresh-install + Smoke Matrix

**Validator**: T1557
**Date**: 2026-04-28
**HEAD commit at validation start**: e4f9b4d3cc0e234dd5f1d0d8af6c7e05de725025
**Baseline reference**: v2026.4.153 (commit e4f9b4d3c)

## Verdict

**SHIP**

All 4 smoke commands exit 0 and produce valid JSON. Build exits 0. All three tarballs pack successfully. `cleo init` from a blank directory succeeds. No P0 blockers found.

## Evidence

| Check | Result | Output snippet |
|-------|--------|----------------|
| `pnpm run build` | PASS | `Build complete.` — exit 0, all 12 packages emitted |
| `pnpm pack @cleocode/cleo` | PASS | `cleocode-cleo-2026.4.153.tgz` (2.0MB) |
| `pnpm pack @cleocode/core` | PASS | `cleocode-core-2026.4.153.tgz` |
| `pnpm pack @cleocode/contracts` | PASS | `cleocode-contracts-2026.4.153.tgz` |
| `pnpm init + pnpm add *.tgz` | PASS | 272 packages installed in 22s |
| `cleo --version` (from project dir) | PASS | `2026.4.153` — exit 0 |
| `cleo version` (JSON form) | PASS | `{"success":true,"data":{"version":"2026.4.153"},...}` — valid JSON |
| `cleo dash` | PASS | `{"success":true,"data":{"project":"Test","summary":{"total":460,...}}}` — valid JSON, exit 0 |
| `cleo find "test"` | PASS | `{"success":true,"data":{"results":[...],"total":297},...}` — valid JSON, exit 0 |
| `cleo memory observe "V1 smoke" --title "V1"` | PASS | `{"success":true,"data":{"id":"O-moj0kd90-0","type":"discovery",...}}` — valid JSON, exit 0 |
| `cleo init` (blank dir) | PASS | Initialized project with 12 created artifacts, exit 0 |
| JSON validity — all outputs | PASS | All stdout-only outputs parse as valid JSON |
| ExperimentalWarning suppression | PASS | `bin/cleo.js` passes `--disable-warning=ExperimentalWarning` — warning absent in CLI output |

## Findings

### P0 (blocker)
_None_

### P1 (concerning)

- `packages/cleo/package.json` — `openai@4.104.0` requires `zod@^3.23.8` as a peer, but the workspace ships `zod@4.3.6`. pnpm reports `✕ unmet peer zod@^3.23.8`. The conflict does not break any of the 4 smoke commands but may affect code paths that use OpenAI structured outputs / response_format with Zod schemas. Risk: latent runtime failure in AI-completion workflows that invoke `openai` with a Zod schema parser at runtime. No CLI command tested here exercises that path.

- `packages/cleo/cleocode-cleo-2026.4.153.tgz` build scripts blocked by pnpm sandbox — `Ignored build scripts: @cleocode/cleo` (postinstall). The postinstall correctly detects it is not a global install and exits 0 (`CLEO: Skipping global bootstrap`). For a true global install (`npm install -g`), postinstall will run. For local/project installs, skipping is correct behavior. Not a regression.

- `node:sqlite` ExperimentalWarning — Node.js v24.13.1 emits this on module load. The `bin/cleo.js` wrapper correctly suppresses it using `--disable-warning=ExperimentalWarning`. Confirmed absent in CLI output. No action needed.

### P2 (note)

- `punycode` deprecation warning (`DEP0040`) appears on stderr for every CLI invocation. This is a transitive dep (likely from `openai` → `formdata-node` → `node-domexception`). Cosmetic only; does not affect function or exit codes.

- `boolean@3.2.0` and `node-domexception@1.0.0` are deprecated subdependencies (via `onnxruntime-node@1.24.3` and `openai@4.104.0` respectively). No functional impact observed.

- `cleo --version` and `cleo init` emit a JSON WARN line to stderr when run outside a CLEO project directory: `"Not inside a CLEO project. Run cleo init or cd to an existing project"`. This is expected behavior — the startup migration check (`T310`) fires before command dispatch. The WARN is structured JSON, not a crash, and does not affect exit codes. However, it can confuse users running `cleo --version` to check if the install succeeded. Consider suppressing the startup check for `--version` specifically.

- Fresh install node_modules: 1.5GB / 273 pnpm virtual store packages. Heavy footprint due to `@huggingface/transformers`, `onnxruntime-node`, tree-sitter parsers (13 languages), and `sharp`. These are runtime dependencies pulled in transitively. Not a regression but worth noting for install UX.

## Recommendations

- **Should this branch ship as v2026.4.154?** YES — all smoke commands pass, build is green, fresh install functional.
- **Pre-release fix required**: None blocking. The `zod@^3.23.8` vs `zod@4.x` mismatch is a P1 to track; if `openai` structured output features are used in v2026.4.154 user paths, validate those explicitly before shipping.
- **Post-release follow-up**:
  1. Resolve `zod` peer dep conflict by pinning `openai` to a version that supports `zod@4.x` OR aligning workspace zod back to `^3.x` (check which direction is intentional).
  2. Suppress T310 startup migration check for `--version` flag to avoid cosmetic JSON WARN noise for new users.
  3. Consider a dedicated `pnpm install --production` footprint audit task — 1.5GB install is large for a CLI tool.
