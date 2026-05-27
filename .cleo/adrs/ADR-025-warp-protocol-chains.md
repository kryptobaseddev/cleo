# ADR-025: Warp Protocol Chains

## Context
CLEO's workshop language provides powerful conceptual metaphors (Thread, Loom, Tapestry, Cascade, Tome). As the system matures, we need a formalized concept that synthesizes composable workflow shape (the continuous flow of agentic work through structured stages) and LOOM's quality gates (the strict phase transitions in RCASD-IVTR+C) into a single, cohesive construct within the lore and workshop vocabulary.

Currently, agents execute operations with quality checks, but the overarching synthesis of "shaped workflow + strict quality gates" lacks a dedicated, evocative name in the canonical documentation.

## Decision
We introduce **Warp** (or Protocol Chains) into the canonical workshop language.

* **Warp** represents the vertical, structural threads of the system's pipeline — the unyielding constraints and gates.
* It is the synthesis of composable workflow shape (topology and continuous flow) and LOOM's rigid quality gates.
* When a Tapestry (multi-Loom campaign) is woven, it is the **Warp** that holds the structure together, ensuring that the weft (the actual generative work of the agents) adheres to protocol and safety standards.

## Status
Accepted

## Consequences
- The workshop language now formally integrates "Warp" alongside "Weft" or "Thread", completing the loom metaphor.
- Technical documentation referring to protocol validation or strict sequence gating can utilize "Warp Protocol Chains" to map abstract engine rules to the workshop lore.
- Documentation such as the CLEO Manifesto and System Flow Atlas will be updated to reflect this new construct.
