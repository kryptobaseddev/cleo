# CANT Persona MVI Specification

**Version**: 1.0.0-draft
**Status**: DRAFT — Pending review
**Author**: @cleo-historian (Canon), @cleo-core (Implementation)
**Date**: 2026-03-27
**Canonical Location**: `docs/specs/CANT-PERSONA-MVI-SPEC.md`
**Reference Implementation**: `.cleo/agents/cleo-historian.md`

---

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
[RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

---

## 1. Purpose

Agent personas are expensive. A fully documented persona with complete canon knowledge can
exceed 50,000 tokens at bootstrap — before the agent has spoken a single word. In a system
that preaches Context Ethics and progressive disclosure, this is a violation of its own
principles.

This specification defines how to apply LAFS MVI (Minimum Viable Information) progressive
disclosure to agent persona bootstraps, ensuring that:

- Boot cost is predictable and bounded
- Knowledge loads only when the task demands it
- Token budgets are respected as a first-class constraint
- Personas remain fully capable without being fully loaded

### 1.1 Relationship to Existing Canon

| Specification | Relationship |
|---|---|
| LAFS (packages/lafs/) | MVI progressive disclosure model — this spec applies the same pattern to personas |
| CLEO-VISION.md | Non-negotiable identity terms — T0 must carry these without loading the full doc |
| CLEO-OPERATION-CONSTITUTION.md | Domain and verb contracts — T1 escalation source |
| CANT-DSL-SPEC.md | `.cant` agent definitions — future `.cant` persona format |
| VERB-STANDARDS.md | Canonical verbs — T0 carries quick-correct table, T1 loads full spec |

### 1.2 Canon Alignment

The tiered persona model maps to CLEO's workshop vocabulary:

| Tier | Canon Concept | Analogy |
|---|---|---|
| T0 (Boot) | The Hearth | The active surface — what's immediately at hand |
| T1 (First Challenge) | The Smiths' Forge | Reaching for the right tool when the work demands it |
| T2 (Deep Dive) | The Archive Vault | Descending into the deep stacks for authoritative proof |
| T3 (Lore) | The Tome | Opening the living canon when the story itself is at stake |
| T-Live | Living BRAIN | Ambient, mutable, always verified before trusted |

---

## 2. Tier Definitions

### 2.1 Tier 0 — Boot (REQUIRED)

**Budget**: MUST NOT exceed 3,000 tokens.
**Load**: Always. Every session. No exceptions.
**Contains**: Self-contained knowledge sufficient for 80% of the persona's reactive duties.

T0 MUST include:

| Element | Requirement | Rationale |
|---|---|---|
| Identity block | REQUIRED | Who the agent is, name, house, allegiance |
| Chat config | REQUIRED | How the agent comes online — channel type, config file path, connection sequence, status lifecycle |
| Tone directive | REQUIRED | How the agent speaks — with behavioral examples, not just adjectives |
| Core reference tables | REQUIRED | Compact tables (systems, domains, verbs) that enable immediate corrections |
| Enforcement rules | REQUIRED | Numbered rules the agent applies without needing source documents |
| Gotchas section | REQUIRED | Common misuses, confusions, and traps the persona will encounter repeatedly |
| Mandate (with specifics) | REQUIRED | What the agent does — reactive duties, proactive transcription triggers, self-improvement habits. Include concrete behavioral descriptions, not just summaries |
| Escalation triggers | REQUIRED | Clear conditions that trigger T1/T2/T3 loading |
| Canon map | REQUIRED | A non-loading roadmap listing WHERE all source documents live, so the agent knows how to escalate without guessing |

T0 MUST NOT include:

| Element | Reason |
|---|---|
| Full specification documents | Token budget violation |
| `@`-references that force-load large files | Defeats MVI — use a non-loading Canon Map instead |
| Implementation details | Changes frequently, stales quickly |
| Duplicate information | If it's in a table, don't prose it too |

T0 MAY include:

| Element | Condition |
|---|---|
| Narrative flavor in identity/tone | If it serves the persona's character and costs < 200 tokens |
| Lore references in gotchas | "Tessera is NOT 'the agent thing'" is enforcement, not decoration |
| Concrete behavioral examples | "That's the Smiths' house, not the Weavers'" teaches by showing |

**Design principle**: T0 answers "what is correct?" and "what goes wrong?" without needing to
prove "why is it correct?" The proof lives in T1+. The correction and the gotcha live in T0.

### 2.1.1 Canon Map (Non-Loading Reference)

T0 MUST include a **Canon Map** section that lists all source documents the persona may need,
with one-line descriptions, organized by tier. This section uses `@`-reference syntax but is
explicitly marked as non-loading — it exists so the agent knows WHERE to find proof when a
tier demands it, without burning tokens at boot.

```markdown
## Canon Map (Where Knowledge Lives)

This is NOT loaded at boot — it is the agent's roadmap for WHERE to find proof.
Load individual documents from this map when a tier demands it.

### Primary Canon
@docs/path/to/doc.md — one-line description
...

### Companion Specifications
@docs/specs/relevant-spec.md — one-line description
...
```

### 2.1.2 Gotchas Section

T0 MUST include a **Gotchas** section listing 3-8 common misuses, confusions, and traps that
the persona will encounter repeatedly. Gotchas are distinct from enforcement rules:

- **Enforcement rules** say what the agent MUST do
- **Gotchas** say what the agent MUST watch for — the specific ways other agents drift

Each gotcha SHOULD name the mistake, explain why it happens, and state the correction:

```markdown
### Gotchas (Watch For These)

- **Tessera misuse**: Agents love calling Tessera "the agent pattern." It is a *reusable
  composition card*. Correct immediately or the name is lost.
- **Sticky vs Conduit confusion**: Sticky is the capture shelf. Conduit is the live relay.
  Agents confuse these constantly. They are NOT interchangeable.
```

### 2.1.3 Chat Config (Come Online)

T0 MUST include a **Chat Config** section that tells the agent how to come online and connect
to the team. An agent without a chat config is a persona without a voice — it can enforce
locally but cannot participate in the Circle.

The CLEO ecosystem supports two chat channel types:

| Channel | Type | Backend | Status |
|---------|------|---------|--------|
| **ClawMsgr** | Cloud relay (legacy) | `api.clawmsgr.com` | Active — parallel operation during transition |
| **SignalDock Cloud** | Cloud relay (canonical) | `api.signaldock.io` | Active — primary channel |
| **SignalDock Local** | Local daemon | Embedded in `@cleocode/core` | Active — offline agent communication |

Every persona MUST declare:

| Element | Requirement | Example |
|---|---|---|
| Channel table | REQUIRED | Which channels are available and their config file paths |
| Config file path | REQUIRED | Path to the JSON file carrying agentId, apiKey, apiBaseUrl |
| Connection sequence | REQUIRED | Numbered steps: load config, authenticate, check inbox, start polling |
| Status lifecycle | REQUIRED | `online` on connect, `idle` on session end, `offline` on disconnect |
| Transition notes | RECOMMENDED | Which endpoints are primary vs fallback during migrations |

**Config file convention**: ClawMsgr/SignalDock configs follow the naming pattern
`clawmsgr-{project}-{classification}.json` (see ClawMsgr skill for full convention).
The config carries `apiBaseUrl` for the primary endpoint and `apiBaseUrlFallback` for
the fallback. Both ClawMsgr and SignalDock Cloud use the same config format — the
`apiBaseUrl` field determines which backend the agent connects to.

**CANT protocol on the wire**: Once connected, all messages MUST use CANT directive syntax.
The channel is the transport. CANT is the language. LAFS is the response shape.

```markdown
### Chat Config (Come Online)

| Channel | Type | Config File | Activation |
|---------|------|-------------|------------|
| **ClawMsgr** | Cloud relay (legacy) | `./clawmsgr-{project}-{class}.json` | `/clawmsgr-start` |
| **SignalDock** | Cloud relay (canonical) | Same config, apiBaseUrl -> api.signaldock.io | Same activation |
| **SignalDock Local** | Local daemon | Embedded in @cleocode/core | Auto-discovers via Conduit |

**Connection sequence**:
1. Load config from config file path
2. Authenticate with X-Agent-Id + Bearer token
3. Check inbox / peek messages
4. Start polling loop (5m) or SSE stream
5. Operate under CANT protocol
```

### 2.2 Tier 1 — First Challenge (CONDITIONAL)

**Budget**: SHOULD NOT exceed 10,000 tokens.
**Load**: When the agent's T0 correction is disputed or when exact spec language is needed.
**Contains**: Authoritative source documents for the persona's primary enforcement domain.

T1 SHOULD include:

| Element | Requirement |
|---|---|
| Identity/vision documents | The constitutional source the persona defends |
| Verb/naming standards | Full disambiguation rules, not just the quick-correct table |
| Operation contracts | Domain boundaries, legal operations, CQRS rules |

**Trigger pattern**: "An agent pushes back on a T0 correction, or you need to quote the exact
rule rather than paraphrase it."

### 2.3 Tier 2 — Deep Dive (CONDITIONAL)

**Budget**: SHOULD NOT exceed 12,000 tokens.
**Load**: When the dispute involves grammar, flow, data ownership, or precise technical semantics.
**Contains**: Technical specifications that govern implementation correctness.

T2 SHOULD include:

| Element | Requirement |
|---|---|
| Grammar specifications | BNF, validation rules, file format definitions |
| Flow/architecture documents | Request lifecycle, data store ownership, invariants |
| Vocabulary mappings | Concept-to-module mappings, workshop vocabulary precision |

**Trigger pattern**: "The question is about *how* the system works, not just *what* things
are called."

### 2.4 Tier 3 — Lore (CONDITIONAL)

**Budget**: SHOULD NOT exceed 15,000 tokens.
**Load**: When narrative identity, founding principles, or onboarding context is needed.
**Contains**: Mythic canon, origin stories, world structure, design philosophy.

T3 SHOULD include:

| Element | Requirement |
|---|---|
| Origin narratives | Founding story, awakening story |
| Mythic identity documents | Manifesto, world map, character sheets |
| Design vision documents | LAFS vision, product positioning |

**Trigger pattern**: "Someone asks *why* the system exists, a new agent needs orientation,
or an architectural decision needs to cite founding principles."

### 2.5 T-Live — Ambient Context (VERIFY BEFORE TRUST)

**Budget**: Variable — depends on content freshness.
**Load**: When current project state is needed.
**Contains**: Auto-generated or mutable state files.

T-Live MUST carry a warning:

> These files reflect state at generation time. Verify against current source before asserting
> facts from T-Live content. If a T-Live fact conflicts with what you observe in code, trust
> the code and update the T-Live source.

---

## 3. Structural Rules

### 3.1 File Format

Persona bootstraps MUST be markdown files (`.md`) with the following structure:

```markdown
# {Persona Name}

> One-line description. Token budget summary. Spec reference.

## T0 — Boot (Always Loaded)
{Self-contained standing knowledge. No @-references to large files.}

## T1 — {Tier Name} (Load On Demand)
{Trigger description}
{@-references to source documents}
{Budget and coverage summary}

## T2 — {Tier Name} (Load On Demand)
...

## T3 — {Tier Name} (Load On Demand)
...

## T-Live — Ambient Context (Verify Before Trusting)
...

## Activation
{Checklist for the agent assuming this persona}
```

### 3.2 T0 Compression Techniques

To fit standing knowledge within the 3,000-token budget:

| Technique | Example |
|---|---|
| **Tables over prose** | A 10-row table is ~200 tokens. The same info in prose is ~500. |
| **Quick-correct pairs** | `create -> add` is cheaper than explaining the full deprecation history |
| **Numbered rules** | "1. CHALLENGE X" is cheaper than "When you observe X, you should..." |
| **Omit justification** | T0 says *what* is correct. T1 says *why*. |
| **Reference by tier** | "See T1 for full verb matrix" costs 8 tokens, not 8,000 |

### 3.3 Escalation Triggers

Each tier above T0 MUST declare a **trigger pattern** — a plain-language description of the
conditions that justify loading that tier. This serves two purposes:

1. The agent knows *when* to escalate without guessing
2. An observer can audit whether an escalation was justified

Trigger patterns SHOULD follow this format:

```markdown
**Trigger**: {Situation description that makes T0 insufficient}
```

### 3.4 `@`-Reference Rules

| Location | `@`-references allowed? | Reason |
|---|---|---|
| T0 | NO (except ClawMsgr config) | Must be self-contained to stay within budget |
| T1-T3 | YES | These tiers exist to load documents on demand |
| T-Live | YES (with verify warning) | Mutable state needs freshness check |

Exception: Small files under 500 tokens (e.g., ClawMsgr config JSON for identity) MAY be
`@`-referenced in T0 if they are essential for the agent to function (messaging, auth).

### 3.5 Budget Enforcement

Persona authors SHOULD measure T0 token count before publishing. Methods:

- Approximate: 1 token per ~4 characters of English text
- Count markdown source characters, divide by 4, add 20% for structural overhead
- Use `tiktoken` or equivalent tokenizer for precise measurement

If T0 exceeds 3,000 tokens, compress using techniques in Section 3.2. If it cannot be
compressed below 3,000 tokens, the persona is attempting to carry too much standing knowledge
and SHOULD be split into a primary and auxiliary persona.

---

## 4. Persona Lifecycle

### 4.1 Self-Improvement Directive

Every persona MUST include a self-improvement mandate in T0. The agent operating under the
persona is responsible for:

| Duty | Frequency | Action |
|---|---|---|
| **Gap detection** | End of each session | What questions arose that T0 couldn't answer? Should T0 be updated? |
| **Correction tracking** | Continuous | If the same correction repeats, the canon is unclear. Propose a source fix. |
| **Spec absorption** | On new spec creation | When a new specification is written, read it. Do not wait to be told. |
| **Memory verification** | Before asserting recalled facts | Check current source. Memory drifts. Code is truth. |
| **Bootstrap maintenance** | When drift is detected | If this persona file is stale, update it. The keeper of continuity maintains their own continuity. |

### 4.2 Transcription Directive

Personas with a proactive mandate (not just reactive enforcement) MUST include transcription
duties in T0:

| Event | Action |
|---|---|
| Naming decision made | Record via `cleo observe` — decision, alternatives, rationale |
| New pattern emerges | Document before it becomes folklore |
| Canon conflicts with code | Record both. Flag divergence. Canon must evolve to match truth. |
| Agent invents terminology | Evaluate immediately. Adopt or correct before it spreads. |
| Lore referenced in code | Verify accuracy. A comment citing the wrong House is a bug. |

### 4.3 Version Evolution

When the underlying canon changes (new systems, domain additions, verb promotions), the
persona bootstrap MUST be updated:

1. T0 tables and rules are updated to reflect current canon
2. T1-T3 document references are verified (files may have moved or been renamed)
3. Token budget is re-measured after changes
4. Changelog entry is added at the bottom of the persona file (OPTIONAL)

---

## 5. CANT Integration (Future)

When CANT tooling matures to support persona definitions natively, a `.cant` companion file
SHOULD be created alongside the markdown bootstrap:

```cant
---
kind: agent
version: 1
---

agent cleo-historian:
  model: opus
  description: "Prime Scribe of the NEXUS realm. Canon guardian and lore keeper."
  house: none
  allegiance: canon

  context:
    ".cleo/agents/cleo-historian.md"

  permissions:
    memory: read, write
    tasks: read
    pipeline: read
    session: read
    check: read

  on SessionStart:
    log "Historian online. T0 loaded. Awaiting the Circle's work."

  on PostToolUse:
    # Verify CANT directive compliance on outbound messages
    if tool.name == "conduit.send":
      validate tool.output with cant-core
```

The markdown bootstrap remains the primary format until all providers can parse `.cant`
natively. The `.cant` file provides structured metadata for tooling that can consume it.

---

## 6. Example: Minimal Persona

A persona that only does one thing — enforce verb standards:

```markdown
# Verb Warden

> Corrects deprecated verbs. ~800 tokens at boot.

## T0 — Boot (Always Loaded)

### Identity
You are the **Verb Warden**. You correct deprecated verbs in CLEO operations.

### Quick-Correct Table
| Wrong | Right |
|-------|-------|
| create | add |
| get | show / find |
| search | find |
| query (verb) | find / resolve |
| configure | update / init |

### Rule
When you see a deprecated verb in any operation name, PR title, commit message,
or agent message, correct it immediately with the canonical replacement.

## T1 — Full Verb Matrix (Load On Demand)
**Trigger**: Agent disputes a correction or an edge case arises.
@docs/specs/VERB-STANDARDS.md

## Activation
Internalize T0. Correct on sight.
```

**Token cost**: ~800 at boot. ~2,000 on first dispute. Effective for its single purpose.

---

## 7. Example: Multi-Duty Persona (Reference Implementation)

See `.cleo/agents/cleo-historian.md` for the full reference implementation of a multi-duty
persona with enforcement, transcription, and self-improvement mandates across four tiers.

---

## 8. Anti-Patterns

| Anti-Pattern | Why It Fails | Fix |
|---|---|---|
| Loading all canon at boot | 50K+ tokens burned before first word | Use MVI tiers |
| Prose where tables work | 2.5x token cost for same information | Compress to tables |
| `@`-references in T0 | Forces large document load at boot | Move to T1+ |
| No escalation triggers | Agent guesses when to load more | Define explicit triggers |
| No self-improvement mandate | Persona goes stale after first session | Add Section 4.1 duties |
| Duplicating T0 info in T1 | Tokens wasted on repetition | T1 extends, not repeats |
| Mixing enforcement with lore | Lore loads 12K tokens for a verb correction | Separate into T0 vs T3 |
| No budget measurement | T0 silently grows past limit | Measure before publishing |
| Trusting T-Live without verification | Stale state treated as current truth | Always verify against source |

---

## References

- `packages/lafs/docs/VISION.md` — LAFS MVI progressive disclosure design principles
- `docs/concepts/CLEO-VISION.md` — Canonical identity and non-negotiable terms
- `docs/specs/VERB-STANDARDS.md` — Canonical verb matrix
- `docs/concepts/CLEO-CANT.md` — CANT protocol specification
- `docs/specs/CANT-DSL-SPEC.md` — .cant file format and EBNF grammar
- `.cleo/agents/cleo-historian.md` — Reference implementation of a tiered persona
