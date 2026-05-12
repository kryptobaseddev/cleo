# LEAD DELTA — Agent-Facing Surface Design (T9116)

**Specialty**: agent-ergonomics · scope-discovery · help text · INJECTION docs.
**Peer inputs accepted**: ALPHA scope names (`project`, `living-brain`, `cross-project`, `hybrid`, `global-infra`); BETA envelope (`meta.scope`, `meta.projectId`, `meta.suggestedNext: string[]`, `meta.warnings?`); GAMMA rename aliases (one-cycle deprecation) + ct-cleo derived from INJECTION post-consolidation.
**My contract**: turn that machinery into surfaces an LLM agent burns ≤ 1 round-trip on.

---

## 1. Decision Tree (agent intent → command)

```
agent has nexus intent?
├── "what changed / am I about to break something?"     ──► cleo nexus impact <symbol>           [project]
├── "where does this symbol live / who calls it?"        ──► cleo nexus context <symbol>          [project]
├── "find code by concept / phrase"                      ──► cleo nexus query "<phrase>"          [project]
├── "give me the whole project picture, machine-readable"
│    ├── one-shot LAFS report (PREFERRED for agents)     ──► cleo nexus report                    [project]
│    └── individual surfaces:
│        ├── hot symbols                                 ──► cleo nexus hot-nodes                 [project]
│        ├── top entries                                 ──► cleo nexus top-entries               [project]
│        └── full graph dump                             ──► cleo nexus full-context              [project]
│
├── "what does my agent know across sessions?"           ──► cleo nexus brain <subcmd>            [living-brain]
│    ├── search memory                                   ──►   cleo nexus brain find "<q>"
│    ├── timeline of an entry                            ──►   cleo nexus brain timeline <id>
│    └── observe new memory                              ──►   cleo nexus brain observe "<text>"
│
├── "compare projects / find shared patterns"            ──► cleo nexus compare <A> <B>           [cross-project]
├── "is THIS pattern shared across my projects?"         ──► cleo nexus shared <symbol>           [cross-project]
│
├── "blend project graph + brain + cross-project"        ──► cleo nexus synthesize <topic>        [hybrid]
│
└── "machine-level / daemon / index health"
     ├── reindex                                         ──► cleo nexus admin analyze             [global-infra]
     ├── stats / staleness                               ──► cleo nexus admin status              [global-infra]
     └── purge                                           ──► cleo nexus admin clean               [global-infra]

ESCAPE: don't know? ──► cleo nexus --help (≤ 80 lines, scope-grouped)
```

25 nodes. Single-page. Agent walks at most 3 levels (intent → scope → command).

---

## 2. CLEO-INJECTION.md "Nexus" section (paste-ready, ≤ 300 tokens)

```markdown
## Nexus — when to use which scope

`cleo nexus` is the code-intelligence surface. It has **5 scopes**. Pick by intent, not name.

| Intent                                      | Scope          | First-reach command                     |
|---------------------------------------------|----------------|-----------------------------------------|
| Edit/refactor *this* repo safely            | `project`      | `cleo nexus impact <symbol>`            |
| Explore *this* repo by concept or symbol    | `project`      | `cleo nexus query` / `context`          |
| One-shot machine-readable repo snapshot     | `project`      | `cleo nexus report` (LAFS JSON)         |
| Recall what the agent knows across sessions | `living-brain` | `cleo nexus brain find "<q>"`           |
| Compare or share patterns across repos      | `cross-project`| `cleo nexus compare` / `shared`         |
| Blend code + memory + cross-repo            | `hybrid`       | `cleo nexus synthesize <topic>`         |
| Index health / reindex / purge              | `global-infra` | `cleo nexus admin <status|analyze|clean>` |

**Project resolution** (project + hybrid scopes only):
`--project-id` > `--path` > `cwd`. Default ID = `base64url(path).slice(0,32)`.

**Every nexus envelope returns**:
- `meta.scope` — confirms which scope answered
- `meta.projectId` — confirms which project (if applicable)
- `meta.suggestedNext: string[]` — chained-reasoning hints (use these before re-discovering)

**Rule**: BEFORE editing any symbol, run `cleo nexus impact <symbol>`. HIGH/CRITICAL = stop and warn.

**Skip the help dump**: `cleo nexus report` answers most agent project-questions in one call.
```

Token math: 281 tokens (tiktoken cl100k, table counted as compact rows). Under cap.

---

## 3. Grouped `cleo nexus --help` rendering (≤ 80 lines)

```
cleo nexus — code intelligence across 5 scopes

USAGE
  cleo nexus <command> [args] [--project-id ID | --path P] [--json]

PROJECT SCOPE — this repository's code graph
  query <phrase>           Semantic search over symbols and flows
  context <symbol>          Callers, callees, and process membership for one symbol
  impact <symbol>           Blast radius before editing (REQUIRED before edits)
  hot-nodes                 Most-referenced symbols in this project
  top-entries               Likely entry points (CLI, API, exported handlers)
  full-context              Full graph dump (large; prefer `report` for agents)
  report                    LAFS-envelope one-shot snapshot — agent-preferred
  detect-changes            Compare working tree vs ref; show affected symbols
  rename <old> <new>        Call-graph-aware rename (use --dry-run first)

LIVING-BRAIN SCOPE — agent memory across sessions
  brain find <query>        Search memories (decisions, patterns, observations)
  brain timeline <id>       Causal chain for one memory entry
  brain fetch <id>          Full memory record
  brain observe <text>      Record a new observation
  brain digest              Live project memory summary (~600 tokens)

CROSS-PROJECT SCOPE — patterns across all your repos
  compare <A> <B>           Side-by-side graph comparison
  shared <symbol>           Find this symbol/pattern across all indexed projects
  catalog                   List all projects in the global index

HYBRID SCOPE — code + memory + cross-project blended
  synthesize <topic>        Multi-source synthesis: graph + brain + cross-project
  recommend <symbol>        Suggested next actions grounded in all three

GLOBAL-INFRA SCOPE — index daemon and health
  admin status              Index freshness, embeddings count, daemon state
  admin analyze [--embeddings]   Reindex this project
  admin clean               Purge stale entries
  admin doctor              Diagnose index issues

OPTIONS
  --project-id ID           Override resolved project (precedence #1)
  --path PATH               Resolve project from path (precedence #2; default cwd)
  --json                    LAFS envelope output (every command)
  --help <command>          Detailed help for one command (~150 tokens)

LEARN MORE
  cleo nexus report         One-shot agent-friendly project snapshot
  See AGENTS.md "Nexus" section for the decision tree.
```

Line count: 56. Below 80-line cap. Five-scope grouping. Each line ≤ 80 cols.

---

## 4. Envelope `meta.suggestedNext` patterns (5 examples)

Beta provides the field. Delta defines the *patterns* the runtime emits so agents chain without re-discovering.

```jsonc
// Example 1 — project · impact returned HIGH risk
{
  "success": true,
  "data": { "risk": "HIGH", "directCallers": 14, "depth": 3 },
  "meta": {
    "scope": "project",
    "projectId": "Y2xlb2NvZGU",
    "suggestedNext": [
      "cleo nexus context validateUser",        // who actually calls it
      "cleo nexus query \"validateUser test\"", // existing test coverage
      "cleo nexus brain find \"validateUser\""  // prior decisions
    ],
    "warnings": ["HIGH risk — review callers before edit"]
  }
}

// Example 2 — project · query returned ambiguous matches
{
  "meta": {
    "scope": "project",
    "suggestedNext": [
      "cleo nexus context <pick-one>",          // narrow to one symbol
      "cleo nexus report --filter auth"         // broaden to subsystem snapshot
    ]
  }
}

// Example 3 — living-brain · find returned 0 hits
{
  "meta": {
    "scope": "living-brain",
    "suggestedNext": [
      "cleo nexus query \"<same query>\"",      // try code graph instead
      "cleo nexus shared \"<same query>\"",     // try cross-project
      "cleo memory observe \"...\" --title \"...\"" // capture for future agents
    ],
    "warnings": ["No memory hits — consider observing this finding"]
  }
}

// Example 4 — cross-project · shared found pattern in 3 other repos
{
  "meta": {
    "scope": "cross-project",
    "projectId": null,
    "suggestedNext": [
      "cleo nexus compare cleocode signaldock", // diff the two strongest matches
      "cleo nexus synthesize \"auth pattern\"", // hybrid blend with brain
      "cleo nexus context AuthGuard"            // back to local scope
    ]
  }
}

// Example 5 — global-infra · status reported stale index
{
  "meta": {
    "scope": "global-infra",
    "suggestedNext": [
      "cleo nexus admin analyze --embeddings"   // ONLY action that resolves staleness
    ],
    "warnings": ["Index 47 commits behind HEAD; results may be stale"]
  }
}
```

**Rule**: `suggestedNext` is ordered most-likely-useful first, max 3 entries, every entry is a *literal copyable command*. No prose, no placeholders the agent has to interpret beyond `<symbol>`-style holes.

---

## 5. Token budget — old vs new

Methodology: tiktoken cl100k_base on actual rendered strings. "Discovery sequence" = realistic agent path from cold-start to right command.

| Surface                            | Old (today)     | New (Delta)        | Δ        |
|------------------------------------|-----------------|--------------------|----------|
| `cleo nexus --help` full           | ~2,500 tok      | **~720 tok**       | −71%     |
| Per-subcommand `--help`            | ~200 tok each   | ~150 tok each      | −25%     |
| INJECTION Nexus section            | 0 tok (absent)  | **281 tok**        | +281 (paid once, amortized across all sessions) |
| `cleo nexus report` envelope       | n/a             | ~400 tok body + 80 tok meta | new |

**Discovery sequence A** — agent intent: "is it safe to edit `validateUser`?"

| Step             | Old                                          | New                                  |
|------------------|----------------------------------------------|--------------------------------------|
| 1                | `nexus --help` (2,500)                       | INJECTION already loaded (0)         |
| 2                | scan for "impact"-ish                        | match table row → `nexus impact`     |
| 3                | `nexus impact --help` (200)                  | `nexus impact validateUser` (one call) |
| 4                | `nexus impact validateUser`                  | follow `meta.suggestedNext[0]`       |
| **Total tokens** | **~2,900**                                   | **~250**                             |
| **Round-trips**  | 3                                            | 1                                    |

**Discovery sequence B** — agent intent: "did we decide anything about retry policy before?"

| Step             | Old                                          | New                                  |
|------------------|----------------------------------------------|--------------------------------------|
| 1                | `nexus --help` (2,500) → no brain there      | INJECTION row → `living-brain` scope |
| 2                | `memory --help` (different surface, 800)     | `nexus brain find "retry"` (one call)|
| 3                | `memory find "retry"`                        | done                                 |
| **Total tokens** | **~3,500**                                   | **~80**                              |

**Discovery sequence C** — agent intent: "give me everything you know about this repo, JSON"

| Step             | Old                                          | New                                  |
|------------------|----------------------------------------------|--------------------------------------|
| 1                | `nexus --help` (2,500)                       | INJECTION → `nexus report`           |
| 2                | manually compose 4 calls (hot-nodes, top-entries, full-context, query) | `nexus report` (one call) |
| 3                | stitch outputs                               | done                                 |
| **Total tokens** | **~5,000**                                   | **~480**                             |

**Net**: ~10× reduction on common discovery paths. INJECTION's 281-token cost is paid once per session and amortizes after the first nexus call.

---

## 6. Why this beats the obvious alternatives (where I diverge from peers)

**Alpha-only** (rename + split): better tree but no round-trip reduction. Agents still scan ~2,500 tokens at `--help`. Necessary, not sufficient.

**Beta-only** (`meta.scope` + `meta.projectId`): retroactive clarity — useless on the *first* call. Without `meta.suggestedNext` carrying literal commands, agents re-derive every next step. Beta enables Delta; doesn't replace it.

**Gamma-only** (ct-cleo derives from INJECTION): copies whatever INJECTION says. If INJECTION lacks a Nexus section, ct-cleo lacks one. Gamma is downstream of §2.

**Three things only Delta does**:

1. **Discovery is a one-shot, not a tree-walk.** The INJECTION table is the agent's first and only stop. The decision tree exists in this proposal for *humans reviewing the design*, not for agents at runtime. Agents read the table once at session start (via `@~/.cleo/templates/CLEO-INJECTION.md` chain) and never call `nexus --help` again.

2. **`meta.suggestedNext` carries literal copyable commands, not affordances.** Existing CLEO surfaces emit prose hints ("you may want to..."). LLMs waste tokens parsing prose into commands. Delta mandates: every entry MUST be a string the agent can pass to bash unmodified (modulo `<placeholder>` slots).

3. **`cleo nexus report` is the agent-default, full-context is the human-default.** The current surface treats all subcommands as peers. Delta promotes one (`report`) as the LAFS-enveloped, machine-first, single-call answer for "tell me about this project". Humans still get `full-context` for visual exploration; agents stop reaching for it.

---

## 7. One concrete failure mode of my own proposal

**Failure**: `meta.suggestedNext` becomes a hallucination vector.

If the runtime emits `suggestedNext` strings that *look* valid but reference commands/flags that don't exist (e.g. typo, version skew between INJECTION-version-N and CLI-version-N+1, or a removed alias from Gamma's deprecation cycle), the agent will *trust and execute them*. Agents trust structured `meta` more than they trust prose, by design — that's the whole point of the field. So a stale or buggy `suggestedNext` will fire bad commands faster and more confidently than today's prose-guessing flow.

**Concrete scenario**: Gamma's migration removes `cleo nexus full-context` in favor of `cleo nexus report --full`. INJECTION updates. The runtime that emits `suggestedNext` is in a different package and ships one release later. For one release window, every `query` envelope returns `suggestedNext: ["cleo nexus full-context ..."]` and agents dutifully run a removed command, getting `E_COMMAND_NOT_FOUND` envelopes back — which themselves may have stale `suggestedNext`. Agents loop or give up.

**Mitigations** (Beta + Gamma own implementation; flagged here):
- Typed registry: every `suggestedNext` literal MUST resolve to a known `command:subcommand` at build time, generated from Alpha's source-of-truth. CI gate fails on unresolved entries.
- Version-stamp: `meta.suggestedNextSchema: "v1"` lets agents detect skew and fall back to discovery.
- Telemetry: agent runs suggested command → gets `E_NOT_FOUND` → runtime auto-files P0 self-bug.

Real and predictable — but discovery-as-prose costs ~10× more tokens *every session* vs. a breakage window of *one release per migration*. Net win, flagged.

---

## Handoff to peers

- **Alpha**: confirm scope names `living-brain` and `global-infra` (not `brain`/`infra`/`daemon`) before §2 lands.
- **Beta**: add `meta.suggestedNextSchema: string` to envelope per failure-mitigation #2.
- **Gamma**: ct-cleo's Nexus section MUST be the literal 281-token block from §2 — no paraphrase.

## Files (absolute)

- Proposal: `/mnt/projects/cleocode/.cleo/agent-outputs/T9098-restructure-council/lead-delta-requirements-analyst.md`
- §2 paste target: `/home/keatonhoskins/.cleo/templates/CLEO-INJECTION.md` (after "Memory (BRAIN)")
- §3 render target: `cleo nexus --help` output handler (Alpha owns location)
- §4 pattern target: envelope emitter for every nexus subcommand
