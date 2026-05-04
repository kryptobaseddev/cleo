---
name: ct-council
description: Convene "The Council" — a 5-advisor, shuffled gate-based peer-review, chairman-synthesis workflow for reviewing a plan, decision, architecture, or piece of work inside the current project. Use when the user says "convene the council" (or "counsel"), "get the council on this", "council review", "run the five advisors", "stress-test this", "get multiple perspectives", or asks for a rigorous multi-angle challenge of a proposal (Contrarian, First Principles, Expansionist, Outsider, Executor → shuffled peer review with pass/fail gates → convergence detector → Chairman verdict). Operates on the current codebase — each advisor grounds their analysis in actual files/commits before opining. Output is validated by scripts/validate.py.
---

# The Council

## Overview

The Council reviews a proposal, plan, architecture decision, or existing implementation from five locked perspectives, cross-checks each perspective through a shuffled gate-based peer review, runs a convergence detector to catch frame drift, then has a Chairman synthesize one final verdict for the owner.

**Five advisors** → **Shuffled peer review (4 pass/fail gates per reviewee)** → **Convergence detector** → **Chairman synthesis** → **Single verdict to owner**.

Every Council run's output is validated by `scripts/validate.py` — structural failures are caught automatically.

## When to use

- Owner presents a plan, design, or existing implementation and wants it stress-tested from multiple angles.
- A decision is high-stakes enough that a single-perspective analysis feels thin.
- The user explicitly invokes the council ("convene the council", "council on X", "run the five", etc.).

Do NOT use for simple factual questions, routine implementation tasks, or anything the user wants a quick answer on. The Council is heavyweight by design.

## The five advisors

Each advisor has their own progressive-disclosure file with full persona, mandate, hard rules, and self-contained output template. When running an advisor pass, **load only that advisor's file** — this enforces frame integrity and works equally well in single-Claude mode (re-read per pass) and subagent mode (each subagent briefed with only their persona).

| Advisor | Frame | Produces | Persona file |
|---|---|---|---|
| Contrarian | Devil's advocate / risk analyst | Failure modes with trigger conditions | [references/contrarian.md](references/contrarian.md) |
| First Principles | Zero-based rebuilder | Atomic truths + reconstructed solution | [references/first-principles.md](references/first-principles.md) |
| Expansionist | Frame-expander / opportunity-spotter | Asymmetric upside + latent assets | [references/expansionist.md](references/expansionist.md) |
| Outsider | Cold-read stranger | Claim/reality gaps from the artifact alone | [references/outsider.md](references/outsider.md) |
| Executor | Action-only | Exactly one 60-minute action with expected outcome | [references/executor.md](references/executor.md) |

Each persona's "Your lane vs. other advisors' lanes" section enforces boundaries — frame bleed fails the G3 gate in peer review.

## Execution mode — subagents are the default

**Default: subagent mode.** Spawn five parallel `Agent` calls, one per advisor. Each subagent receives *only* the shared evidence pack and the path to their own persona file — nothing else. This is the only execution mode with true frame isolation, and it is the default for any non-trivial question.

**Exception: single-Claude mode** is permitted only when (a) the question is extremely narrow (single file, single function), or (b) subagent infrastructure is unavailable. In single-Claude mode, Claude re-reads each persona file before each pass and explicitly acknowledges the "Your lane vs." section. The convergence detector (Phase 2.5) is especially load-bearing in this mode.

## Canonical file layout (mandatory)

Every run lives under a run directory (`<run-dir>/`, created by `scripts/run_council.py init`). **Each subagent writes its own output file** — the orchestrator does NOT transcribe agent text into its own context. This is structurally important: agent outputs land directly on disk, the orchestrator reads them back when needed (or at assembly time), and the run directory is the audit trail.

| File | Owner | When written |
|---|---|---|
| `<run-dir>/phase0.md` | **Orchestrator** | Phase 0 (evidence pack) |
| `<run-dir>/phase1-contrarian.md` | **Contrarian agent** | Phase 1 |
| `<run-dir>/phase1-first-principles.md` | **First Principles agent** | Phase 1 |
| `<run-dir>/phase1-expansionist.md` | **Expansionist agent** | Phase 1 |
| `<run-dir>/phase1-outsider.md` | **Outsider agent** | Phase 1 |
| `<run-dir>/phase1-executor.md` | **Executor agent** | Phase 1 |
| `<run-dir>/peer-contrarian-on-first-principles.md` | **Contrarian-as-reviewer agent** | Phase 2 |
| `<run-dir>/peer-first-principles-on-expansionist.md` | **First Principles-as-reviewer agent** | Phase 2 |
| `<run-dir>/peer-expansionist-on-outsider.md` | **Expansionist-as-reviewer agent** | Phase 2 |
| `<run-dir>/peer-outsider-on-executor.md` | **Outsider-as-reviewer agent** | Phase 2 |
| `<run-dir>/peer-executor-on-contrarian.md` | **Executor-as-reviewer agent** | Phase 2 |
| `<run-dir>/phase2_5.md` | **Orchestrator** | Phase 2.5 (convergence) |
| `<run-dir>/phase3.md` | **Orchestrator** (or Chairman agent if delegated) | Phase 3 |
| `<run-dir>/output.md` | **Orchestrator** (assembled from above) | After Phase 3 |
| `<run-dir>/verdict.md`, `tldr.md` | **Auto-generated** by `run_council.py ingest` | After validate |

The agent file-write contract: each Phase-1 / Phase-2 subagent must use the `Write` tool to save its full output markdown to the path above and return ONLY a one-line confirmation. The orchestrator does NOT include the agent's full output in its return-context — that bloats the orchestrator window unnecessarily.

### Subagent briefing template — Phase 1 (advisor)

Pass this verbatim to each Agent call, substituting the bracketed values:

```
You are the <Advisor Name>. Read your persona, mandate, hard rules, and output
template at this path before producing any output:

  packages/skills/skills/ct-council/references/<advisor-slug>.md

The restated question is: <restated question from Phase 0>

The evidence pack is:
  1. <file:line | commit | symbol> — <rationale>
  2. ...

Produce exactly the output specified in your persona file's "Your output"
template. Do not break frame. Cite at least two items from the evidence pack.
Stay strictly in your lane — the "Your lane vs. other advisors' lanes" section
is enforced in peer review.

WRITE your full output to this exact path using the Write tool:

  <run-dir>/phase1-<advisor-slug>.md

After the file is written, return ONLY a one-line confirmation
(e.g. "Wrote phase1-contrarian.md, sharpest point: <one-clause summary>").
DO NOT include the full advisor analysis in your reply — the orchestrator reads
it back from the file at assembly time.
```

### Subagent briefing template — Phase 2 (peer review)

The peer-review briefing follows the fixed rotation (`Contrarian → First Principles`, etc.). Each reviewer reads three files: their own persona, the reviewee's persona (for the G3 lane check), and the reviewee's actual output.

```
You are <Reviewer> running a peer review of <Reviewee>. Read these files
in order before producing any output:

  1. packages/skills/skills/ct-council/references/<reviewer-slug>.md
     (your persona — stay in this frame)
  2. packages/skills/skills/ct-council/references/<reviewee-slug>.md
     (reviewee's persona — the "Your lane vs. other advisors' lanes" section
     is what G3 Frame integrity is enforced against)
  3. <run-dir>/phase1-<reviewee-slug>.md
     (the output you are evaluating)
  4. packages/skills/skills/ct-council/references/peer-review.md
     (gate format, output template, hard rules — the gate-line format is
     load-bearing; "G1 Rigor:" not "G1 Rigor gate:")

The shared evidence pack lives at: <run-dir>/phase0.md

Evaluate the reviewee against the four gates (G1 Rigor, G2 Evidence grounding,
G3 Frame integrity, G4 Actionability). Each gate is strictly PASS or FAIL —
no PARTIAL / MIXED. The verdict-line format MUST match exactly:

  - G1 Rigor: PASS|FAIL — <evidence>
  - G2 Evidence grounding: PASS|FAIL — <evidence>
  - G3 Frame integrity: PASS|FAIL — <evidence>
  - G4 Actionability: PASS|FAIL — <evidence>

Do NOT append "gate" to the verdict-line names (the validator regex rejects it).

WRITE your full peer-review output to this exact path using the Write tool:

  <run-dir>/peer-<reviewer-slug>-on-<reviewee-slug>.md

After the file is written, return ONLY a one-line confirmation including the
gate-pass count and disposition (e.g. "Wrote peer-contrarian-on-first-principles.md
— 4/4 PASS, Disposition: Accept"). DO NOT include the full peer review in your
reply — the orchestrator reads it back from the file.
```

## Phase ownership — who executes what

The skill uses a mix of orchestrator-owned and agent-owned phases. Know which is which before running:

| Phase | Owner | Writes file | Why |
|---|---|---|---|
| Phase 0 — evidence pack | **Orchestrator** | `phase0.md` | Needs codebase access + project memory; produces the shared pack distributed to all 5 advisors. |
| Phase 1 — 5 advisor passes | **Independent agents** | `phase1-<slug>.md` (each agent writes its own) | True frame isolation requires separate Claude instances; each agent writes directly to disk so the orchestrator never sees the full advisor text mid-flight. |
| Phase 2 — 5 peer reviews | **Independent agents** | `peer-<reviewer>-on-<reviewee>.md` (each agent writes its own) | Reviewer frame-integrity requires seeing only their own persona + reviewee's output + persona; agent writes the review file directly. |
| Phase 2.5 — convergence check | **Orchestrator** | `phase2_5.md` | Needs all 5 sharpest points at once; mechanical pairwise check (validated by `telemetry.py --phase-2-5`); not a frame-locked judgment. |
| Phase 3 — Chairman verdict | **Orchestrator (default)** or 6th agent (optional) | `phase3.md` | Default: orchestrator reads all advisor + peer-review files directly. Optional: spawn Chairman as a 6th `Agent` call that writes `phase3.md` itself. |
| Final assembly | **Orchestrator** | `output.md` | Concatenates `phase0.md` + 5 advisor files + 5 peer-review files + `phase2_5.md` + `phase3.md`. |
| Lean deliverables | **Auto-generated** | `verdict.md`, `tldr.md` | Created by `run_council.py ingest` after structural validation. |

**Chairman-as-agent is recommended when:**
- The decision is high-stakes and the orchestrator's context may be polluted by other work.
- The advisors produced genuinely contested verdicts (not just different angles on the same conclusion) that benefit from a fresh reader.
- You want the Chairman's verdict to be independently auditable (the 6th agent's briefing + output becomes its own reviewable artifact).

**Chairman-as-orchestrator is fine when:** the context is clean, the advisors converged through different routes, and you want lower token spend.

## Workflow

Four phases (Phase 0, Phase 1, Phase 2 + 2.5, Phase 3). Each phase finishes before the next begins. Phase 0 is validator-gated; Phase 2.5 may trigger a rerun.

### Phase 0 — Intake and ground-truthing (validator-gated)

Produce:
1. **A restated question** — one sentence, testable decision shape.
2. **Evidence pack** — 3–7 items, each with citation + one-line rationale.

The validator refuses to accept the output if either is missing or malformed. Phase 1 does not start until Phase 0 passes.

Full guidance, item types, and format → [references/evidence-pack.md](references/evidence-pack.md).

**For external docs / APIs / specs**, use the `llmtxt:<slug>[@<version>]` evidence-pack item type and fetch compressed overviews via `scripts/llmtxt_ref.py` (api.llmtxt.my). Anonymous reads work for public docs (60/min per IP; anonymous session cookie persisted locally); set `LLMTXT_API_KEY` for private/org docs. Cached under `~/.cache/council/llmtxt/` — indefinitely for pinned versions, 60s for `latest`.

### Phase 1 — Advisor analysis (5 parallel or sequential passes)

For each of the 5 advisors, produce one output section following the persona's output template exactly. Cite at least 2 items from the evidence pack.

Subagent mode: spawn 5 parallel `Agent` calls with the briefing template above.
Single-Claude mode: run 5 sequential passes, re-reading each persona file before each pass.

### Phase 2 — Shuffled gate-based peer review

Every advisor's output is reviewed by exactly one other advisor via the fixed rotation. No self-review, every advisor reviews once and is reviewed once:

```
Contrarian       → reviews → First Principles
First Principles → reviews → Expansionist
Expansionist     → reviews → Outsider
Outsider         → reviews → Executor
Executor         → reviews → Contrarian
```

The reviewer evaluates the reviewee against **4 pass/fail gates** (not numeric scores), each requiring quoted evidence:

- **G1 Rigor** — are findings specific and non-hedged?
- **G2 Evidence grounding** — does every finding cite from the evidence pack?
- **G3 Frame integrity** — does every finding stay in the reviewee's lane?
- **G4 Actionability** — does the verdict cash out to a decision?

Full gates, evidence requirements, and review template → [references/peer-review.md](references/peer-review.md).

### Phase 2.5 — Convergence detector (MANDATORY)

After all five peer reviews complete, before the Chairman synthesizes:

1. Extract the "Single sharpest point" from each advisor (5 sentences).
2. Pairwise-compare. Are ≥3 semantically the same finding (same subject + predicate)?
3. If YES → **convergence flag**. Rerun the advisor(s) with the lowest gate-pass count, with explicit frame-reinforcement (re-read "Your lane vs." section). Re-review the new output. Repeat until the flag clears.
4. If NO → proceed to Phase 3.

The convergence detector is the structural antibody to single-Claude-mode frame smearing. Even in subagent mode, run it — it catches cases where frames were under-specified for the question.

### Phase 3 — Chairman synthesis

The Chairman is a separate voice (not one of the five advisors). Reads all five advisor analyses + all five peer reviews (with gate results) + verifies Phase 0 and Phase 2.5 completed, then produces the final verdict.

Per-advisor weight is computed from gate-pass count (0–4). The verdict MUST:
- State a single clear recommendation (no fence-sitting).
- Include the full gate summary table.
- Reconcile contradictions explicitly.
- Carry forward the sharpest finding from each of the five advisors.
- End with the Executor's 60-minute action and a confidence rating.

Full synthesis protocol and verdict template → [references/chairman.md](references/chairman.md).

## Output contract — three-tier deliverables

Every validated Council run produces **three artifacts** under `<run-dir>/`. They serve different consumers; do not conflate them:

| File | ~Lines | Purpose | Audience |
|---|---|---|---|
| `tldr.md` | 10-15 | Recommendation + action + confidence (level only) | PR comments, chat, status updates |
| `verdict.md` | 60-80 | Full Chairman section with question header — **the deliverable** | Owner / decision-maker |
| `output.md` | 300-400 | Phase 0 + 5 advisors + 5 peer reviews + 2.5 + 3 — full transcript | Audit trail, post-hoc analysis |

The full transcript was the historical primary output; the verdict was buried at the bottom. After shakedown #5+ telemetry showed every consumer was scrolling past 290 lines of upstream artifacts to reach the Chairman section, the three-tier split was made canonical. **`verdict.md` is what you hand the owner; `output.md` is what proves it's defensible.**

### Full transcript structure (`output.md`)

```
# The Council — <one-line question>

## Evidence pack

## Phase 1 — Advisor analyses
### Advisor: Contrarian
### Advisor: First Principles
### Advisor: Expansionist
### Advisor: Outsider
### Advisor: Executor

## Phase 2 — Shuffled peer reviews
### Contrarian reviewing First Principles
### First Principles reviewing Expansionist
### Expansionist reviewing Outsider
### Outsider reviewing Executor
### Executor reviewing Contrarian

## Phase 2.5 — Convergence check

## Phase 3 — Chairman's verdict
```

### Run index — find past runs across the project

Every run is auto-indexed at `.cleo/council-runs/INDEX.jsonl` — a project-scoped human-readable roster (one line per run with title, description, status, hash, run_dir). Distinct from the deeper `.cleo/council-runs.jsonl` telemetry log. The INDEX is the "find me that run from last Tuesday" surface; the telemetry log is what `analyze_runs.py` reads.

```bash
# At init, an entry is written with status=initialized
python3 scripts/run_council.py init "<question>" --title "<short>" --description "<longer>"

# At ingest, the entry is updated with status=ingested + verdict snippet + validation summary
python3 scripts/run_council.py ingest <run-dir>

# Browse / search
python3 scripts/run_council.py list                       # newest-first table
python3 scripts/run_council.py list --status initialized   # only in-progress runs
python3 scripts/run_council.py list --limit 10             # last 10
python3 scripts/run_council.py list --json                 # JSON
python3 scripts/run_council.py find "convergence"          # substring search
python3 scripts/run_council.py show <run-id-prefix>        # full INDEX entry
python3 scripts/run_council.py reindex                     # rebuild from run.json files
```

The `--title` flag is optional; if omitted the title is auto-derived from the question (interrogative prefix stripped, truncated to 60 chars). The `--description` flag is also optional and defaults to the full question.

### Validation + auto-generation

`scripts/run_council.py ingest <run-dir>` validates `output.md`, then automatically writes `verdict.md` and `tldr.md` to the same run dir, then appends a telemetry record to `.cleo/council-runs.jsonl`. Direct usage:

```bash
# Full output (default)
python3 scripts/validate.py <output.md>          # exit 0 = structurally valid

# Partial files (when assembling phase-by-phase)
python3 scripts/validate.py --phase 0 <phase0.md>  # only H1 + evidence pack
python3 scripts/validate.py --phase 1 <file.md>    # +5 advisor sections
python3 scripts/validate.py --phase 2 <file.md>    # +5 peer reviews

python3 scripts/run_council.py ingest <run-dir>  # validate + verdict.md + tldr.md + telemetry
```

The validator **auto-detects partial files** when no `--phase` is passed: if no Phase 3 header is present, it validates up to the highest phase the file contains and prints a stderr suggestion. This prevents the "12 missing-section errors" wall of red when you're checking a phase0.md or phase1-*.md mid-flight.

Exit code 0 = structurally valid. Non-zero = fix the violations before surfacing the verdict.

## Worked example

A compact end-to-end golden run is in [references/examples.md](references/examples.md). Read it before your first council run so you have a concrete reference for what "good" looks like at each phase.

## Anti-patterns (reject any council run that does these)

- Skipping Phase 0 validator gate and opining from memory.
- Skipping Phase 2.5 convergence detector and letting a synthesized verdict cover convergent advisor outputs.
- Running an advisor pass without loading the persona file first — frame won't hold.
- Treating the 4 gates as numeric scores — they are pass/fail with quoted evidence required.
- Peer reviewer producing a second copy of their own analysis instead of evaluating the reviewee.
- Chairman writing "on one hand / on the other hand" — the Chairman decides.
- Five advisors reaching identical conclusions (Phase 2.5 should have caught this).
- Using the council for trivial questions where one clear answer already exists.

## Validation

The `scripts/validate.py` checker enforces:

- Phase 0 gate (restated question + 3–7 evidence items with rationales).
- All 5 advisor sections with required subsections.
- Executor produced exactly one action.
- Peer review rotation matches the fixed 5-cycle.
- Each peer review has 4 gates with PASS/FAIL and cited evidence.
- Phase 2.5 convergence check was run.
- Chairman verdict has all required subsections + gate summary.

Tests live in `scripts/test_validate.py` and `scripts/test_telemetry.py` — run via `python3 -m unittest test_validate test_telemetry` from the `scripts/` directory.

## Telemetry & systematic hardening

The Council learns from itself. Every validated run should be ingested into a JSONL log so failure-mode patterns surface across runs instead of being lost between sessions.

```bash
# 1. Initialize a run directory + skeleton phase0.md
python3 scripts/run_council.py init "<one-sentence question>" --scenario <name>

# 2. Orchestrator does Phase 0..3, assembles the artifact at <run-dir>/output.md
#    (subagent mode is the default — see "Execution mode" above).

# 3. Ingest: validate + emit telemetry to .cleo/council-runs.jsonl
python3 scripts/run_council.py ingest <run-dir> --tokens <N> --wall-clock <secs>

# 4. After several runs, surface hotspots
python3 scripts/analyze_runs.py
```

**Phase 2.5 structured extractor** (`telemetry.py --phase-2-5 <run-dir>`) replaces the prose-only convergence channel with a versioned JSON artifact. Reads each `phase1-<advisor>.md` file, parses the `**Single sharpest point:**` line (anchored on start-of-line — inline mentions in action bodies do not match), computes pairwise same-finding via exact-normalized + Jaccard token-overlap ≥ 0.6, and raises `flag_mechanical=true` iff a 3-clique exists in the pairwise-same graph (matches the protocol's "≥3 semantically the same finding" rule). Output schema includes `sharpest_points`, `pairwise_same`, `pair_methods`, `missing_advisors`, `jaccard_threshold`. Use this as the structured-output channel that the orchestrator's manual semantic Phase 2.5 should agree with — divergence is a signal to refine either the threshold or the manual read.

`analyze_runs.py` reports:

- **Gate-failure hotspots** — which (advisor, gate) pair fails most. A gate failing in ≥2 runs is systemic; harden the persona file, not the run.
- **Peer-review disposition distribution** — all-Accept across many runs signals reviewers being too lenient (G3 frame-integrity is the usual culprit).
- **Convergence flag rate** — should fire rarely; high rate means frame definitions are too narrow for the questions being asked.
- **Chairman confidence distribution** — recurring `low` or `medium-low` confidence on similar question shapes is a candidate for documenting "not a good council fit."
- **Token + wall-clock spread** — exit criterion target is ≤20% per scope tier.

Scenario tags for `--scenario` (from the hardening plan): `baseline`, `external-doc-heavy`, `three-way`, `sparse-ops`, `contradictory`, `non-cleo`, `mini`, `contention`. These let `analyze_runs.py` dimension hotspots by question shape.

The JSONL schema is documented in `scripts/telemetry.py` (`TelemetryRecord`), versioned via `schema_version`.

## Invocation examples

- "Convene the council on whether we should migrate from SQLite to Postgres."
- "Council review of the T1140 worktree-by-default design."
- "Run the five advisors on this PR before I merge."
- "Stress-test this plan with the council."
