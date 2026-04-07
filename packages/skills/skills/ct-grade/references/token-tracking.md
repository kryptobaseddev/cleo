# Token Tracking Reference

**Skill**: ct-grade
**Version**: 1.0.0
**Status**: APPROVED

---

## Overview

Token tracking matters for three reasons in ct-grade evaluations:

1. **Cost tracking**: Each A/B run consumes real tokens. Knowing the cost per run helps budget multi-scenario evaluations.
2. **MCP vs CLI comparison**: The primary value of ct-grade is comparing MCP efficiency against CLI. Token consumption is a direct measure of interface efficiency — lower tokens for the same score means better efficiency.
3. **Score-per-token efficiency**: A session scoring 85/100 with 2,000 tokens outperforms one scoring 90/100 with 8,000 tokens on an efficiency basis. The eval-viewer surfaces this ratio as `score_per_1k_tokens`.

**Important constraint**: Claude Code does not expose per-call token counts during agent execution. There is no API to query "how many tokens did this operation consume" in real time. Token counts arrive only via OpenTelemetry telemetry (if configured) or must be approximated from response payload size. This is why ct-grade uses a three-layer estimation system.

---

## Three Estimation Methods

Token estimates are produced by one of three methods, ordered by confidence:

| Method | Confidence | When Available | How |
|--------|-----------|----------------|-----|
| OTel telemetry | REAL | When `CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTel configured | Reads `~/.cleo/metrics/otel/*.jsonl`, field `claude_code.token.usage` |
| Response chars ÷ 4 | ESTIMATED | After A/B test runs | Counts response payload characters, divides by 4 (industry standard approximation) |
| Coarse op averages | COARSE | Always | Multiplies op count by `OP_TOKEN_AVERAGES` lookup table |

The eval-viewer labels every token figure with its confidence level so you know how to interpret the number.

---

## OTel Setup

OTel telemetry provides the most accurate token counts (REAL confidence). It requires a one-time shell setup.

```bash
# One-time setup — add to ~/.bashrc or ~/.zshrc
source /path/to/.cleo/setup-otel.sh

# What the script sets:
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT="file://${HOME}/.cleo/metrics/otel/"
```

After sourcing, restart your shell or run `source ~/.bashrc` (or `~/.zshrc`).

Once configured, Claude Code writes session token metrics to `~/.cleo/metrics/otel/` as JSONL files. The ct-grade analysis scripts read these files and match them to run sessions by timestamp overlap. The relevant field is `claude_code.token.usage` which contains `input`, `output`, and `cache_read` sub-fields.

**Verification**: After a graded session, check that files exist under `~/.cleo/metrics/otel/`. If the directory is empty, telemetry is not active for your current shell session.

---

## Per-Operation Token Budget Table

The coarse estimation layer uses the following lookup table (`OP_TOKEN_AVERAGES`). These averages were measured across real CLEO sessions and are used when neither OTel nor char-counting is available.

| Operation | Estimated Tokens | Notes |
|-----------|-----------------|-------|
| tasks.find | ~750 | Depends on result count |
| tasks.list | ~3,000 | Heavy — prefer tasks.find |
| tasks.show | ~600 | Single task with full details |
| tasks.find | ~300 | Use with exact:true for existence check |
| tasks.tree | ~800 | Hierarchy view |
| tasks.plan | ~900 | Next task recommendations |
| session.status | ~350 | Quick status check |
| session.list | ~400 | Session list |
| session.briefing.show | ~500 | Handoff briefing |
| admin.dash | ~500 | Project overview |
| admin.help | ~800 | Full operation reference |
| admin.health | ~300 | Health check |
| admin.stats | ~600 | Statistics summary |
| memory.find | ~600 | Search results |
| memory.timeline | ~500 | Timeline entries |
| tools.skill.list | ~400 | Skill manifest |
| tools.skill.show | ~350 | Single skill details |

These figures are averages. Actual token counts vary based on the number of results returned, note field length, and payload verbosity. The coarse method is accurate within ±50% and is only used as a last resort when better data is unavailable.

---

## Confidence Labels

Every token figure in the eval-viewer is annotated with one of three confidence labels:

| Label | Source | Accuracy |
|-------|--------|----------|
| `REAL` | OTel telemetry (`claude_code.token.usage`) | Exact — from Claude Code instrumentation |
| `ESTIMATED` | Response chars ÷ 4 | ±20% — good for JSON payloads |
| `COARSE` | Operation count × `OP_TOKEN_AVERAGES` | ±50% — fallback only |

When reading eval-viewer reports, treat REAL figures as authoritative, ESTIMATED figures as directionally accurate, and COARSE figures as rough order-of-magnitude only.

**Recommendation**: Enable OTel telemetry before running multi-scenario or multi-run evaluations. The additional setup is minimal and the REAL confidence data significantly improves the reliability of MCP vs CLI efficiency comparisons.

---

## Chars ÷ 4 Rationale

The chars/4 approximation is applied to response payload character counts when OTel data is unavailable but operation responses were captured in `operations.jsonl`.

This approximation matches CLEO's own `src/core/metrics/token-estimation.ts` and is the same approximation used by OpenAI and Anthropic in their documentation. It is accurate within ±20% for JSON payloads.

The approximation works because English text and JSON structure average roughly 4 characters per token across typical LLM tokenizers (cl100k_base, o200k_base). JSON keys, punctuation, and whitespace are slightly more token-dense than prose, but the ±20% margin accounts for this variance.

For ct-grade specifically, both arms of an A/B test experience the same approximation error, so relative comparisons between MCP and CLI remain valid even when absolute counts are slightly off.

---

## References

- `src/core/metrics/token-estimation.ts` — CLEO's token estimation implementation
- `docs/specs/CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md` — Metrics system specification
- `.cleo/setup-otel.sh` — OTel environment setup script
- `packages/skills/skills/ct-grade/scripts/token_tracker.py` — Token aggregation script
- `packages/skills/skills/ct-grade/scripts/generate_report.py` — Report generator (uses confidence labels)
