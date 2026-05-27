# Phase 0 — Building the Evidence Pack

The evidence pack is the factual ground all five advisors stand on. If it's thin, every downstream phase is thin. If it's padded, advisors drown in irrelevant material. Aim for **3–7 items**, each directly load-bearing for the owner's question.

Every advisor cites from this pack. Peer reviewers check grounding *against* this pack. The Chairman's tiebreaker rules reference "evidence-grounding". Investing here pays off everywhere downstream.

## The Phase 0 gate (structural — validator-enforced)

Phase 1 MUST NOT begin until Phase 0 produces:

1. **A restated question** — one sentence, testable decision shape.
2. **An evidence pack of 3–7 items**, each consisting of:
   - A citation (`path:line-range` | `symbol` | `sha` | URL)
   - A one-line rationale ("why this matters to the question")

If either condition is unmet, the validator reports a structural failure and the advisors refuse to run. This is non-negotiable — Phase 0 is the anchor for frame integrity in Phase 1 and gate scoring in Phase 2.

## What goes in the evidence pack

Each item is one of:

| Type | Format | Example |
|---|---|---|
| File slice | `path/to/file.ts:L123-L150` | `packages/core/src/store.ts:L44-L89` |
| Symbol | `symbolName` (function / class / type) | `validateEnvelope`, `StoreClient.put` |
| Commit | `<short-sha> <one-line summary>` | `4f4426ad9 clean-forward purge of dogfood special cases` |
| Test | `path/to/test.ts::test name` | `packages/cleo/test/brain.test.ts::verifyAndStore` |
| External contract | URL + one-line what it asserts | `ADR-055 — worktree canonicalization` |
| Data point | metric / measurement + source | `BRAIN has 2440 noise patterns (MEMORY.md line 98)` |
| Compressed external doc | `llmtxt:<slug>[@<version>]` — fetched via `scripts/llmtxt_ref.py` | `llmtxt:drizzle-orm-v1@beta.3` |

Each item gets a **one-line "why this matters"** annotation. Without it, advisors won't know which lens to apply.

## The `llmtxt:` item type — for external docs, APIs, and specs

When a question touches an external library, API, or standard that the advisors need to cite but the full text would bloat the evidence pack (especially in subagent mode where 5 advisors each receive the pack), use the `llmtxt:<slug>[@<version>]` item type. The `scripts/llmtxt_ref.py` wrapper fetches a compressed overview from api.llmtxt.my and caches it locally.

**Fetch and paste:**

```bash
# Anonymous read (public docs — wrapper persists the anonymous session cookie automatically)
python3 .claude/skills/council/scripts/llmtxt_ref.py <slug>

# Pinned version (cached indefinitely; immutable)
python3 .claude/skills/council/scripts/llmtxt_ref.py <slug>@<version>

# Private / org docs require an API key
LLMTXT_API_KEY="llmtxt_<43-char-token>" python3 .claude/skills/council/scripts/llmtxt_ref.py <slug>
```

**Caching (automatic):**
- `<slug>@<version>` → cached indefinitely under `~/.cache/council/llmtxt/<slug>/<version>.md` (immutable per service contract).
- `<slug>` (latest) → cached 60s to catch lifecycle state transitions.
- Override cache directory with `COUNCIL_CACHE_DIR`.

**When to use this item type:**
- Question involves an external library, SDK, API, or spec whose docs are load-bearing.
- Multiple advisors will cite the same external source (5× distribution in subagent mode compounds the savings).
- The source has a stable slug + version in the llmtxt catalog.

**When NOT to use it:**
- The reference is already in your local codebase (use `path:line`).
- The reference is a git commit (use the sha directly).
- The source isn't in the llmtxt catalog (use a regular URL citation with a one-line summary).

**Rate limits to respect** (api.llmtxt.my):
- Anonymous per-IP: 60 reads/min.
- Session-authenticated: 300/min.
- API-key Bearer: 600/min.
- Wrapper surfaces `x-ratelimit-*` warnings to stderr and honors `retry-after` on 429.

## How to build it

Do this in order. Stop when you have 3–7 solid items.

1. **Parse the owner's question.** Extract key nouns — subsystem names, file paths, symbol names, ADR numbers, task IDs. Each noun is a candidate search anchor.

2. **Pull the most recent changes.** `git log -20 --oneline` in the relevant paths, or `git log --follow -- <path>`. Anything touched in the last few commits is load-bearing for the question.

3. **Use the best available intelligence tool.**
   - **If `gitnexus` MCP is indexed**: `gitnexus_query({query: "<the owner's question, rephrased as a concept>"})` returns process-grouped execution flows. Then `gitnexus_context({name: "<main symbol>"})` for 360-view. Then `gitnexus_impact({target: "<symbol>", direction: "upstream"})` if the question involves modifying something.
   - **Otherwise**: `grep -rn --include='*.ts' '<keyword>'` for keyword anchors, then `Read` the top hits at relevant line ranges.

4. **Check for ADRs, memory, and docs.** Search `docs/adr/`, `.cleo/memory*`, any referenced `.md` files. Contracts and prior decisions are disproportionately load-bearing for council questions.

5. **Sanity-check with tests.** If a subsystem is involved, find its tests and confirm the current contract. Tests document claimed behavior better than code comments.

## What belongs in the pack vs. what doesn't

**Include** — items that advisors from more than one frame will cite:
- Core code path being discussed (Contrarian finds risks; First Principles checks atomicity; Executor picks an action on it).
- Most recent commit touching it (Outsider spots drift from stated intent; Contrarian checks regression risk).
- The test or assertion that defines its contract (First Principles' atomic truth candidate; Contrarian's "what breaks this" target).
- The relevant ADR or memory entry (Expansionist spots latent capability; Outsider spots claim/reality gaps).

**Exclude** — items only one frame would care about:
- Ambient project lore not touching the question.
- "Everything that mentions X" dumps — noise.
- Speculative or future code that doesn't exist yet.
- The owner's plan itself (that's the thing *being reviewed*, not evidence advisors ground in — keep it separate at the top).

## The restated question

At the top of the evidence pack, restate the owner's question in **one sentence**. All advisors anchor to this. If you can't compress the question into one sentence, the question is too fuzzy — clarify with the owner before running the council.

A good restated question:
- Has a subject (the thing being decided).
- Has a binary or short-list decision shape ("should we X?", "is Y ready to ship?", "which of A/B/C?").
- Is testable — you'd recognize an answer when you saw it.

A bad restated question:
- "What do you think about X?" (no decision shape)
- "Review the codebase" (no scope)
- "Make X better" (no success criterion)

## Phase 0 fact-check (added after shakedown #8 caught a fabricated stat)

**If the restated question contains any quantitative claim about the codebase, prior runs, or external data — "X happens N% of the time", "the historical mean is N", "S1-S5 averaged 6.4 items", "70% of users hit this path" — that claim MUST resolve to a citation in the evidence pack itself.**

In shakedown #8, the orchestrator's question framing said *"S1-S5 averaged 6.4 items"*; the cited `council-runs.jsonl` actually showed all five runs at 7 items (mean 7.0). The Outsider was the only advisor whose frame *required* verifying the cited artifact, and only Outsider caught it — the other four reasoned downstream from a fabricated premise. The pre-action verification rule for the Executor (instituted in shakedown #1) protects the *action* against fabricated paths but does NOT extend upstream to the *question framing*; this gate fills that gap.

Rule: every quantitative claim in the restated question must have a corresponding evidence-pack item that, when read, supports the claim. If the supporting data lives in `.cleo/council-runs.jsonl`, cite that file as a pack item and (in the rationale) name the specific values being claimed. If the supporting data does not exist anywhere in the project, either (a) measure it before running the council and cite the new artifact, or (b) restate the question without the unverifiable quantification.

Anti-patterns this gate catches:
- "Average 6.4 items" with the jsonl never read.
- "Most teams use X" with no survey/data citation.
- "This pattern fails 30% of the time" with no postmortem citation.
- "S1-S5 showed Y" without a per-run breakdown that demonstrates Y.

The Outsider remains the structural backstop, but with this gate the orchestrator should rarely hand the council a question that needs the backstop.

## Output format for Phase 0 (validator-checked)

```
# The Council — <one-line restated question>

## Evidence pack

1. `<path:line-range | symbol | sha | URL>` — <why this matters to the question>
2. `<path:line-range | symbol | sha | URL>` — <why this matters to the question>
3. ...
(3–7 items)
```

Nothing else in Phase 0. No opinions, no framing, no narrative. Just the pack. The advisors read only the question and the pack before forming their views.
