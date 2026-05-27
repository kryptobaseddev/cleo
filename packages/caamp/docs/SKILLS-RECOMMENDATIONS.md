# Skills Recommendation (v0.4.0)

CAAMP v0.4.0 extends `caamp skills find` with deterministic recommendation and LAFS-first machine output.

## CLI

Primary flow:

`caamp skills find "<query>" --recommend --top 5`

Optional criteria flags:

- `--must-have "gitbook,modern,docs-folder"`
- `--exclude "legacy,book.json,gitbook-cli"`
- `--prefer "api,git-sync"`
- `--details`
- `--json`
- `--human`
- `--select 2`

## Output shape

Human mode:

- ranked list
- concise `why` line
- `tradeoff` line
- `CHOOSE: 1,2,3`

Machine mode (`--json`): LAFS envelope with `_meta` and `result`:

- `result.query`
- `result.recommended`
- `result.options[]` with `score`, `reasons[]`, `tradeoffs[]`
- `--details` includes expanded evidence fields

## API surface

Programmatic helpers:

- `searchSkills(query, options)`
- `recommendSkills(query, criteria)`
- `formatSkillRecommendations(result, { mode: "human" | "json" })`

These APIs are stateless and composable.

## Error model

- `E_SKILLS_QUERY_INVALID`
- `E_SKILLS_NO_MATCHES`
- `E_SKILLS_SOURCE_UNAVAILABLE`
- `E_SKILLS_CRITERIA_CONFLICT`

## Ranking notes

The engine is deterministic and non-LLM. Scoring includes query/topic coverage, must-have/prefer/exclude handling, source/quality signals, and modern-vs-legacy heuristics.
