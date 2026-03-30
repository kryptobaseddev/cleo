# T201: Go/No-Go Decision — CANT-Based Subagent Prompts

**Agent**: cleo-historian
**Date**: 2026-03-30
**Epic**: T191 (CANT DSL Subagent Prompt Exploration)
**Decision**: **GO** — with phased adoption

---

## Decision

**GO.** CANT should replace markdown for agent definitions and protocol specifications. The evidence from T192-T200 is unambiguous: CANT provides better structure, fewer tokens, static analysis, and eliminates the duplication problem. Adoption should be phased, not big-bang.

---

## Evidence Summary

| Task | Finding | Weight |
|------|---------|--------|
| T192 (Audit) | Pipeline is 4 components: AGENT.md + protocol + placeholders + injector. All markdown/string-template. .cant files exist but are disconnected from the pipeline. | Foundation |
| T193 (Agent Syntax) | 7 grammar extensions cover 100% of AGENT.md content. Existing .cant syntax already handles ~60%. | Strong GO |
| T194 (Constraints) | Protocol constraints become first-class with RFC 2119 validation. ~60% static + ~15% hook coverage = 75% total. New `kind: protocol` document type needed. | Strong GO |
| T195 (Typed Tokens) | 42 JSON tokens → ~20 typed CANT tokens + grammar enforcement. `${NAME}` interpolation with type checking. Eliminates silent unresolved tokens. | Strong GO |
| T196 (Import Model) | `@import` eliminates ~2,500 tokens of duplication per agent. Tier guards replace HTML comment hacks. Composition enables extend/override patterns. | Strong GO |
| T197 (Prototype Agent) | Full cleo-subagent.cant: 157 lines vs 304 lines AGENT.md (52% reduction). 100% content parity. | Proof |
| T198 (Prototype Protocol) | Full subagent-protocol-base.cant: 113 lines vs 226 lines markdown (50% reduction). Categorized constraints. | Proof |
| T199 (Token Cost) | Single agent: 72% token reduction. 10 agents: 88% reduction. Authoring: 72% fewer lines. | Strong GO |
| T200 (Static Analysis) | 12 of 18 error classes caught statically (67%). 15 of 18 with hooks (83%). Current markdown catches 0%. | Strong GO |

---

## Benefits

### Quantified

| Benefit | Value |
|---------|-------|
| Token savings per agent spawn | ~72% (9,700 → 2,700 tokens) |
| Token savings for 10-agent session | ~88% (97,000 → 12,000 tokens) |
| Authoring line reduction | 72% (963 → 270 lines) |
| Error classes caught pre-deployment | 67% (0 → 12 of 18) |
| Error classes caught with hooks | 83% (0 → 15 of 18) |
| Content duplication eliminated | ~2,500 tokens per shared definition |
| placeholders.json eliminated | 13,341 bytes replaced by inline declarations |

### Qualitative

1. **Single source of truth**: Domains, gateways, protocols defined once via `@import`
2. **LSP integration**: cant-lsp provides error highlighting, autocomplete, go-to-definition
3. **Parser validation**: cant-core (497 tests) validates syntax at build time
4. **Canonical vocabulary enforcement**: Domain names, event names, verb names checked against registry
5. **Composability**: Agents can extend base protocols, skills can declare token requirements
6. **Version control friendly**: Structured blocks diff cleanly vs prose changes

---

## Costs

| Cost | Severity | Mitigation |
|------|----------|------------|
| Parser work needed | Medium | cant-core already parses agent blocks. Extensions (constraints, tokens, tools) need ~200-400 lines of Rust. |
| cant-lsp needs fixes | Low | @cleo-rust-lead already fixed P0 (context_refs). Remaining work is incremental. |
| subagent.ts injection needs rewrite | Medium | New `injectCantProtocol()` function alongside existing `injectProtocol()`. Both can coexist during migration. |
| Learning curve | Low | .cant syntax is self-evident (indentation-based, keyword-prefixed). Existing .cant files prove agents can author them. |
| @import resolution | Medium | Needs implementation in cant-core. Algorithm designed in T196. ~300 lines of Rust. |
| Migration effort | Low | Run in parallel — markdown and CANT coexist. No forced migration. |

---

## Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Parser bugs in new extensions | Medium | Low | cant-core has 497 tests. Extensions follow established patterns. |
| LLM attention degradation | Low | Medium | Hypothesis from T199: CANT structure may *improve* attention. Needs empirical testing. |
| Resistance from agents using markdown | Low | Low | No forced migration. Both formats work. CANT is opt-in. |
| Over-engineering | Medium | Medium | Phase 1 is design + prototypes only. Implementation gated on this decision. |

---

## Adoption Plan

### Phase 1: Foundation (Current — T191, NOW COMPLETE)
- Design grammar extensions (T193-T196) ✓
- Create prototypes (T197-T198) ✓
- Measure costs (T199) ✓
- Assess analysis gap (T200) ✓
- Decision document (T201) ✓

### Phase 2: Parser Extensions (Next Cycle)
- Implement `constraints:` block parsing in cant-core
- Implement `tokens:` block parsing in cant-core
- Implement `tools:` block parsing in cant-core
- Implement `anti_patterns:` block parsing in cant-core
- Implement `kind: protocol` validation
- Add ~200 tests for new constructs
- Expose via cant-napi for TS consumption

### Phase 3: Import Resolution (Following Cycle)
- Implement `@import` resolution algorithm in cant-core
- Create shared .cant definitions (domains.cant, gateways.cant, etc.)
- Build flattening compiler that produces spawn prompts
- Tier-gated import support

### Phase 4: Pipeline Integration
- Add `injectCantProtocol()` to subagent.ts alongside existing markdown injection
- Wire cant-napi to parse .cant agent definitions at spawn time
- Orchestrator flag: `--format cant` to opt into CANT-based spawns
- Parallel running: both markdown and CANT produce prompts, compare outputs

### Phase 5: Migration
- Convert all AGENT.md files to .cant equivalents (8 agents already done)
- Convert subagent-protocol-base.md to .cant (prototype exists)
- Retire placeholders.json (replaced by inline token declarations)
- Set CANT as default spawn format

---

## Consensus Request

This decision requires consensus per PRIME directive (majority +1).

**Stakeholders**:
- @cleo-rust-lead — Parser implementation owner
- @cleo-db-lead — Schema impact (none — this is parser-layer)
- @cleo-dev — Will implement subagent.ts integration
- @cleoos-opus-orchestrator — Epic prioritization

**Vote**: GO with phased adoption as described above.

---

## Linked Tasks

- Epic: T191 (COMPLETE — 10/10 tasks)
- Decision feeds: Phase 2 epic (to be created)
