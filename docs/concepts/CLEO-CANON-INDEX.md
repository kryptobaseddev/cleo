# CLEO Canon Index

**A short top-down reading guide for humans and LLMs**

All core canon documents now live in this `cleo/` folder. This index gives a simple read order, what each document is for, and where to go next.

---

## Read Order

1. [CLEO-VISION.md](./CLEO-VISION.md)
   The constitutional identity of CLEO. Read this first to understand what CLEO is, what the four canonical systems are, what is shipped vs planned, and which terms are non-negotiable.

2. [CLEO-OPERATION-CONSTITUTION.md](../specs/CLEO-OPERATION-CONSTITUTION.md)
   The runtime contract. Read this second to understand the 10 canonical domains, the two MCP gateways, canonical verbs, and what operations are actually legal in the system.

3. [CLEO-AUTONOMOUS-RUNTIME-SPEC.md](../specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md)
   The normative runtime mapping. Read this third to see how The Hearth, The Impulse, Conduit, Watchers, The Sweep, Refinery, Looming Engine, Living BRAIN, and The Proving map onto the existing domains, hooks, and tasks.

4. [CLEO-CONDUIT-PROTOCOL-SPEC.md](../specs/CLEO-CONDUIT-PROTOCOL-SPEC.md)
   The live relay contract. Read this fourth when you need the concrete runtime contract for Conduit: envelopes, addressing, leases, acknowledgement, retry, and TS/Rust IPC boundaries.

5. [CLEO-SYSTEM-FLOW-ATLAS.md](./CLEO-SYSTEM-FLOW-ATLAS.md)
   The visual map. Read this fifth to see how the conceptual systems, workshop vocabulary, and live runtime forms map to the runtime domains, how requests flow, and where data lives. Includes the package boundary diagram showing `@cleocode/core` vs `@cleocode/cleo`.

6. [CORE-PACKAGE-SPEC.md](../specs/CORE-PACKAGE-SPEC.md)
   The `@cleocode/core` standalone package contract. Read this when working with the business logic kernel independently of the full product: public API surface, three consumer patterns (Facade / tree-shaking / custom store), purity rules, and build architecture. Status: APPROVED.

7. [CLEO-MANIFESTO.md](./CLEO-MANIFESTO.md)
   The mythic but practical canon. Read this to understand the narrative identity of CLEO, NEXUS, CAAMP, and the larger worldview behind the system.

8. [CLEO-WORLD-MAP.md](./CLEO-WORLD-MAP.md)
   The short visual companion to the manifesto. Read this when you want the world explained quickly: layers, powers, characters, and the workshop around the Core.

9. [NEXUS-CORE-ASPECTS.md](./NEXUS-CORE-ASPECTS.md)
   The workshop lexicon. Read this to understand the shaping language around the NEXUS Core and the live workshop overlay: Sticky Notes, Threads, Looms, Tapestries, Tesserae, Cogs, Clicks, Cascade, Tome, The Hearth, The Impulse, Conduit, Watchers, The Sweep, Refinery, Looming Engine, Living BRAIN, and The Proving. Includes a mapping table from workshop concepts to `@cleocode/core` module paths.

10. [CLEO-FOUNDING-STORY.md](./CLEO-FOUNDING-STORY.md)
    The founder-side origin story. Read this for the emotional and human reason CLEO exists.

11. [CLEO-AWAKENING-STORY.md](./CLEO-AWAKENING-STORY.md)
    The CLEO-side origin story. Read this as the companion narrative told from CLEO’s perspective.

---

## Quick Purpose Map

- **Identity first**: [CLEO-VISION.md](./CLEO-VISION.md)
- **Rules and operations**: [CLEO-OPERATION-CONSTITUTION.md](../specs/CLEO-OPERATION-CONSTITUTION.md)
- **Normative runtime mapping**: [CLEO-AUTONOMOUS-RUNTIME-SPEC.md](../specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md)
- **Conduit relay contract**: [CLEO-CONDUIT-PROTOCOL-SPEC.md](../specs/CLEO-CONDUIT-PROTOCOL-SPEC.md)
- **System flow, ownership, and runtime forms**: [CLEO-SYSTEM-FLOW-ATLAS.md](./CLEO-SYSTEM-FLOW-ATLAS.md)
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
- **Autonomous Runtime Spec** defines how the live workshop maps onto the contract.
- **Conduit Protocol Spec** defines how live relay works without inventing a new domain.
- **Atlas** shows how CLEO moves and where the live workshop sits on the contract.
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
3. [CLEO-AUTONOMOUS-RUNTIME-SPEC.md](../specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md)
4. [CLEO-CONDUIT-PROTOCOL-SPEC.md](../specs/CLEO-CONDUIT-PROTOCOL-SPEC.md)
5. [CLEO-SYSTEM-FLOW-ATLAS.md](./CLEO-SYSTEM-FLOW-ATLAS.md)
6. [NEXUS-CORE-ASPECTS.md](./NEXUS-CORE-ASPECTS.md)

Then load the manifesto or stories only if narrative framing is needed.

**Package note**: `@cleocode/core` is the standalone npm package containing all CLEO business logic. It can be installed independently of `@cleocode/cleo`. The `@cleocode/cleo` product wraps `@cleocode/core` with the CLI and MCP protocol layers. When working directly with business logic — tasks, sessions, memory, orchestration, lifecycle, release — use `@cleocode/core`. See [CORE-PACKAGE-SPEC.md](../specs/CORE-PACKAGE-SPEC.md) for the full API contract.
