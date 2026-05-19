# Source Strategy

How to pick sources, what order to query them in, and how to bound the search
so that the research task completes within its token budget. The skill has
three primary source channels — web, Context7, and the local codebase — and
each carries different reliability and currency trade-offs.

## Source Hierarchy

| Tier | Source | Strength | Weakness |
|------|--------|----------|----------|
| 1 | Local codebase | Ground truth for the project | Reflects past decisions, not future ones |
| 2 | Context7 (`ctx7 docs`) | Current official library docs | Limited to libraries published to Context7 |
| 3 | Web search | Breadth, recency, community wisdom | Variable signal-to-noise |
| 4 | LLM general knowledge | Conceptual framing | Stale, hallucination-prone |

Always query top-down. Codebase first — the answer may already exist as
prior art. Context7 second when a specific library or framework is named.
Web third when the question is open-ended. LLM general knowledge SHOULD be
used only to frame the question, never as a citable source.

## Codebase Search Patterns

The skill operates in a worktree; the entire repository is reachable via
`Grep`, `Glob`, and `Read`. Use these patterns to find prior art quickly.

```bash
# Find existing ADRs on the topic
Grep: pattern="<keyword>" path=".cleo/adrs/" output_mode="files_with_matches"

# Find prior research notes
Grep: pattern="<keyword>" path=".cleo/agent-outputs/" output_mode="files_with_matches"

# Find BRAIN decisions/patterns/observations on the topic
cleo memory find "<keyword>"

# Find related tasks
cleo find "<keyword>"
```

When the topic touches code symbols, also use the GitNexus tools — they
return execution flows, callers, and impact rings that grep cannot surface.

```bash
gitnexus_query({query: "<concept>"})        # process-grouped flows
gitnexus_context({name: "<symbol>"})        # 360 view of a symbol
gitnexus_impact({target: "<symbol>"})       # blast radius
```

## Context7 (ctx7) Workflow

For any question that names a library, framework, SDK, or CLI tool, use the
`ctx7` CLI before the open web. The workflow is two-step.

```bash
# Step 1 — resolve the library ID
npx ctx7@latest library "<library-name>" "<user-question>"

# Step 2 — fetch docs for the resolved ID
npx ctx7@latest docs <libraryId> "<user-question>"

# Optional — retry with sandboxed agents pulling source + web
npx ctx7@latest docs <libraryId> "<user-question>" --research
```

The official library name is required — pass `"Next.js"` not `"nextjs"`.
Version-specific docs use the `/org/project/version` form (e.g.
`/vercel/next.js/v14.3.0`). Pass the user's full question as the query —
specific queries return better matches than single words.

## Web Search Tactics

Web search is the most variable channel. Apply these filters to keep the
signal high.

- Prefer the canonical source (official docs, GitHub README, RFC) over
  blog posts, Medium, StackOverflow.
- Prefer recent results — append `2026`, `2025`, or the current year when
  the topic is moving fast (LLM APIs, build tools, framework migrations).
- Cross-check at least two sources before stating a fact. A single blog
  post is a lead, not a finding.
- Avoid AI-generated content farms — sites that publish hundreds of
  thin "guides" daily are not citable.
- Strip tracking parameters from URLs when citing — they break and they
  leak provenance.

## Time-Boxing

Research is unbounded by nature; the skill MUST self-limit. Use this
schedule when the task does not specify otherwise.

| Topic complexity | Time budget | Sources to query |
|------------------|-------------|------------------|
| Single library/API question | 5 min | Context7 only |
| "What is the current best practice for X" | 15 min | Web + Context7 |
| "Compare options A, B, C for use-case Y" | 30 min | Web + Context7 + codebase |
| "Audit current implementation against state of the art" | 60 min | All sources |

When the budget is exhausted, write up what was found with `status: partial`
and list remaining questions in `needs_followup`. Partial research is more
useful than abandoned research.

## Citation Format

Every finding MUST carry a source. Acceptable formats:

```markdown
- According to [the Next.js routing docs](https://nextjs.org/docs/app), ...
- Context7 (`/vercel/next.js/v15`) confirms that ...
- See `.cleo/adrs/ADR-065-release-pipeline.md` §3 for prior decision on ...
- The current implementation at `packages/cleo/src/commands/release.ts:42` ...
- BRAIN observation `O-mpd07uma-0` records the pub1-diagnoser refusal pattern.
```

Unsourced claims SHOULD be flagged with `[unsourced]` or moved to a
`Hypotheses` section. The reader must always be able to verify.
