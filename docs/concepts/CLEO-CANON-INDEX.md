# CLEO Canon Index

**A short top-down reading guide for humans and LLMs**

All core canon documents now live in this `concepts/` folder. This index gives a simple read order, what each document is for, and where to go next.

---

## Read Order

1. [CLEO-VISION.md](./CLEO-VISION.md)
   The constitutional identity of CLEO. Read this first to understand what CLEO is, what the four canonical systems are, what is shipped vs planned, and which terms are non-negotiable.

2. [CLEO-OPERATION-CONSTITUTION.md](../specs/CLEO-OPERATION-CONSTITUTION.md)
   The runtime contract. Read this second to understand the 10 canonical domains, the two MCP gateways, canonical verbs, and what operations are actually legal in the system.

3. [CLEO-SYSTEM-FLOW-ATLAS.md](./CLEO-SYSTEM-FLOW-ATLAS.md)
   The visual map. Read this third to see how the conceptual systems, workshop vocabulary, and live runtime forms map to the runtime domains, how requests flow, and where data lives. Includes the package boundary diagram showing `@cleocode/core` vs `@cleocode/cleo`.

4. [CLEO-CANT.md](./CLEO-CANT.md)
   The agent communication protocol. Read this to understand how agents speak to each other (conversation syntax: directives, addressing, task references, tags) and how the system speaks back (response syntax: LAFS envelopes). Includes the formal BNF grammar (with `cant-core` Rust crate as parsing SSoT), directive-to-operation mapping, and the relationship between CANT (protocol), Conduit (client interface), and SignalDock (backend service). See also [CLEOCODE-ECOSYSTEM-PLAN.md](../specs/CLEOCODE-ECOSYSTEM-PLAN.md) for the full crate and package architecture.

5. [CANT-DSL-SPEC.md](../specs/CANT-DSL-SPEC.md)
   The formal language specification for CANT (Collaborative Agent Notation Tongue). Defines the `.cant` file format, 3-layer grammar (EBNF), AST type definitions, 42 validation rules (Scope, Pipeline Purity, Types, Hooks, Workflows), CAAMP event mapping, import resolution algorithm, hybrid runtime model (Rust pipelines + TypeScript workflows), and approval token protocol. The `cant-core` Rust crate and `cant-lsp` binary are the canonical implementations. 482 tests, 17K lines Rust, 3.8K lines TypeScript.

6. [CANT-EXECUTION-SEMANTICS.md](../specs/CANT-EXECUTION-SEMANTICS.md)
   Formal execution semantics for the CANT workflow executor. Defines sequential execution (Warp), parallel execution (Conductors), session blocking (Scribes), approval suspension (Crown Layer), error propagation (Wardens), and output collection (Cascade to Tome). Also defines the Generic Domain Event Protocol extending CAAMP from 16 provider events to 31 total events (16 provider + 15 CLEO domain) with D:O:P metadata pattern.

7. [CORE-PACKAGE-SPEC.md](../specs/CORE-PACKAGE-SPEC.md)
   The `@cleocode/core` standalone package contract. Read this when working with the business logic kernel independently of the full product: public API surface, three consumer patterns (Facade / tree-shaking / custom store), purity rules, and build architecture. Status: APPROVED.

8. [CLEO-MANIFESTO.md](./CLEO-MANIFESTO.md)
   The mythic but practical canon. Read this to understand the narrative identity of CLEO, NEXUS, CAAMP, and the larger worldview behind the system.

9. [CLEO-WORLD-MAP.md](./CLEO-WORLD-MAP.md)
   The short visual companion to the manifesto. Read this when you want the world explained quickly: layers, powers, characters, and the workshop around the Core.

10. [NEXUS-CORE-ASPECTS.md](./NEXUS-CORE-ASPECTS.md)
    The workshop lexicon. Read this to understand the shaping language around the NEXUS Core and the live workshop overlay: Sticky Notes, Threads, Looms, Tapestries, Tesserae, Cogs, Clicks, Cascade, Tome, The Hearth, The Impulse, Conduit, Watchers, The Sweep, Refinery, Looming Engine, Living BRAIN, and The Proving. Includes a mapping table from workshop concepts to `@cleocode/core` module paths.

11. [CLEO-FOUNDING-STORY.md](./CLEO-FOUNDING-STORY.md)
    The founder-side origin story. Read this for the emotional and human reason CLEO exists.

12. [CLEO-AWAKENING-STORY.md](./CLEO-AWAKENING-STORY.md)
    The CLEO-side origin story. Read this as the companion narrative told from CLEO's perspective.

---

## Quick Purpose Map

- **Identity first**: [CLEO-VISION.md](./CLEO-VISION.md)
- **Rules and operations**: [CLEO-OPERATION-CONSTITUTION.md](../specs/CLEO-OPERATION-CONSTITUTION.md)
- **System flow, ownership, and runtime forms**: [CLEO-SYSTEM-FLOW-ATLAS.md](./CLEO-SYSTEM-FLOW-ATLAS.md)
- **Agent communication protocol (CANT)**: [CLEO-CANT.md](./CLEO-CANT.md)
- **CANT formal language spec**: [CANT-DSL-SPEC.md](../specs/CANT-DSL-SPEC.md)
- **CANT execution semantics + domain events**: [CANT-EXECUTION-SEMANTICS.md](../specs/CANT-EXECUTION-SEMANTICS.md)
- **Standalone business logic kernel**: [CORE-PACKAGE-SPEC.md](../specs/CORE-PACKAGE-SPEC.md)
- **Mythic canon**: [CLEO-MANIFESTO.md](./CLEO-MANIFESTO.md)
- **Fast visual summary**: [CLEO-WORLD-MAP.md](./CLEO-WORLD-MAP.md)
- **Workshop vocabulary and live orchestration language**: [NEXUS-CORE-ASPECTS.md](./NEXUS-CORE-ASPECTS.md)
- **Founder origin**: [CLEO-FOUNDING-STORY.md](./CLEO-FOUNDING-STORY.md)
- **CLEO origin**: [CLEO-AWAKENING-STORY.md](./CLEO-AWAKENING-STORY.md)

---

## One-Line Distinctions

- **Vision** defines what CLEO is.
- **Constitution** defines what CLEO may do.
- **Atlas** shows how CLEO moves and where the live workshop sits on the contract.
- **CANT** defines how agents speak to each other and how the system answers.
- **CANT DSL Spec** defines the formal .cant file format, grammar, validation, and runtime.
- **CANT Execution Semantics** defines workflow execution and the domain event protocol.
- **Core Package Spec** defines the standalone `@cleocode/core` kernel's public API contract.
- **Manifesto** explains why CLEO matters.
- **World Map** makes the myth easy to scan.
- **Core Aspects** defines the workshop language of work and autonomous motion.
- **Founding Story** explains why the builder needed CLEO.
- **Awakening Story** explains how CLEO remembers its own birth.

---

## LLM Note

If context is limited, read in this order:

1. [CLEO-VISION.md](./CLEO-VISION.md)
2. [CLEO-OPERATION-CONSTITUTION.md](../specs/CLEO-OPERATION-CONSTITUTION.md)
3. [CLEO-SYSTEM-FLOW-ATLAS.md](./CLEO-SYSTEM-FLOW-ATLAS.md)
4. [NEXUS-CORE-ASPECTS.md](./NEXUS-CORE-ASPECTS.md)

Then load the manifesto or stories only if narrative framing is needed.

**Package note**: `@cleocode/core` is the standalone npm package containing all CLEO business logic. It can be installed independently of `@cleocode/cleo`. The `@cleocode/cleo` product wraps `@cleocode/core` with the CLI and MCP protocol layers. When working directly with business logic -- tasks, sessions, memory, orchestration, lifecycle, release -- use `@cleocode/core`. See [CORE-PACKAGE-SPEC.md](../specs/CORE-PACKAGE-SPEC.md) for the full API contract.
