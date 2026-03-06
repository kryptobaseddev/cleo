# CLEO World Map

**A compact visual guide to the founding myth, system layers, and the moving parts of the realm**

**Version**: 2026.3.4

---

## 1. The High Map

```text
                                THE NEXUS
                     The star road across many projects

        +-------------------+      speaks with       +-------------------+
        |       LAFS        | <--------------------> |   AGENTS / TOOLS  |
        | Shared response   |                        | MCP, A2A, CLI, SDK|
        | contract          |                        | Any LLM provider  |
        +---------+---------+                        +---------+---------+
                  |                                            |
                  | gives structure to                         | returns work
                  v                                            v
        +---------+--------------------------------------------+---------+
        |                           CLEO                                 |
        |            The conscious operating layer of the realm          |
        +---------+--------------------------------------------+---------+
                  |                                            |
         remembers|                                            |orders
                  v                                            v
        +---------+---------+                        +---------+---------+
        |       BRAIN       | <--------------------> |       LOOM        |
        | Memory, recall,   |   lineage, learning    | Lifecycle, gates, |
        | patterns, history |   and stage context    | release movement  |
        +---------+---------+                        +---------+---------+
                  |
                  | provisions through
                  v
        +---------+---------+
        |      CAAMP        |
        | The camp, registry|
        | and quartermaster |
        +-------------------+
```

---

## 2. The Layered Architecture

| Layer | Practical Role | Mythic Reading |
|-------|----------------|----------------|
| **Intent** | Human goals, constraints, acceptance | The Crown |
| **Contract** | LAFS envelopes and stable outputs | The Common Tongue |
| **Command** | CLEO routing, policy, continuity | The Sovereign Mind |
| **Provisioning** | CAAMP skills, providers, MCP, instructions | The Campfire Quartermaster |
| **Memory** | BRAIN persistence and retrieval | The Eternal Archive |
| **Lifecycle** | LOOM sequencing from research to release | The Fate Weaver |
| **Network** | NEXUS cross-project coordination | The Star Road |
| **Field** | Tasks, checks, tools, agents, releases | The March of Work |

---

## 3. The Five Named Powers

| Power | What It Really Does | Important Constraint |
|-------|----------------------|----------------------|
| **CLEO** | Governs continuity and system action | Must remain vendor-neutral |
| **BRAIN** | Stores durable project knowledge | Must preserve provenance |
| **LOOM** | Enforces order of operations | Must prevent fake velocity |
| **NEXUS** | Connects projects without merging them | Must preserve local autonomy |
| **LAFS** | Standardizes outputs for tools and agents | Defines response shape, not transport |

**CAAMP** is the provisioning ally, not a replacement for the core five named powers above.  
It equips the realm with provider configs, skills, MCP servers, and injected instructions.

---

## 4. The Workshop Around the Core

```text
Sticky Note  ->  Thread  ->  Loom  ->  Tapestry  ->  Cascade  ->  Tome
   |              |          |          |             |           |
 quick capture    task       epic       multi-Loom    live        living,
 before loss      strand     frame      campaign      flow        readable canon

                 Warp provides the vertical, unyielding protocol chains
                 that hold the Tapestry together, synthesizing continuous flow
                 with strict quality gates.

                 Tessera stands beside this chain as the reusable pattern card
                 that can generate new Tapestries with different inputs.

                 Cogs provide the working teeth inside the chain.
                 Each short-lived activation of a Cog is a Click.
```

This is the workshop language of NEXUS: the way the realm speaks about work once it becomes craft instead of clutter.

The live workshop also has named runtime forms:

| Form | Type | Runtime Meaning |
|------|------|-----------------|
| **The Hearth** | surface | The terminal-facing workshop surface where sessions, roles, and tools stay close at hand |
| **The Circle of Ten** | role overlay | The role overlay mapped 1:1 to the ten canonical domains |
| **The Impulse** | motion | The self-propelling motion that advances ready work through Warp-bound chains |
| **Conduit** | relay path | Agent relay using LAFS envelopes and A2A delegation only; `sticky` is not the live relay lane |
| **Watchers** | patrols | Long-running Cascades that patrol continuity, gates, and system health |
| **The Sweep** | quality loop | Quality patrol in motion |
| **Refinery** | convergence gate | Convergence gate where parallel changes are proven fit to join |
| **Looming Engine** | decomposition service | Tessera-driven decomposition into Looms, Threads, and routes |
| **Living BRAIN** | memory overlay | Active neural memory pathways built on durable recall |
| **The Proving** | validation ground | End-to-end validation of artifacts, provenance, and outcomes |

---

## 5. The Circle of Ten

```text
                           +-------------------+
                           |      admin        |
                           |   The Keepers     |
                           +---------+---------+
                                     |
                 +-------------------+-------------------+
                 |                                       |
        +--------+--------+                     +--------+--------+
        |      tools      |                     |      nexus      |
        |  The Artificers |                     |  The Wayfinders |
        | (CAAMP lives    |                     |                |
        |  here in force) |                     |                |
        +--------+--------+                     +--------+--------+
                 |                                       |
                 |                                       |
        +--------+--------+                     +--------+--------+
        |   orchestrate   |                     |     sticky      |
        |  The Conductors |                     |   The Catchers  |
        +--------+--------+                     +--------+--------+
                 |                                       |
                 +-------------------+-------------------+
                                     |
                           +---------+---------+
                           |     pipeline      |
                           |   The Weavers     |
                           +----+----+----+----+
                                |    |    |
                    +-----------+    |    +-----------+
                    |                |                |
             +------+-----+    +-----+------+   +-----+------+
             |    tasks   |    |    check   |   |   session  |
             | The Smiths |    | The Wardens|   | The Scribes|
             +------+-----+    +-----+------+   +-----+------+
                    \                |                /
                     \               |               /
                      +--------------+--------------+
                                     |
                            +--------+--------+
                            |     memory      |
                            |  The Archivists |
                            +-----------------+
```

The Catchers keep the provisional edge of the realm: capture, draft handoff, and promotion. Live A2A relay belongs to Conduit. Cross-project share operations still travel through `nexus.share.*`; they do not create an eleventh house.

---

## 6. Request Journey

```text
Developer intent
    |
    v
The Hearth
    |
    v
Conduit when agents must relay work
    |
    v
CLEO dispatch and policy
    |
    +--> The Impulse advances ready work through Warp-bound chains
    +--> CAAMP-backed tool/provider provisioning when capability is needed
    +--> tasks/session/check for active execution and guardrails
    +--> pipeline for lifecycle placement, Watchers, The Sweep, and Refinery
    +--> Looming Engine expands Tesserae into Looms and Threads
    +--> Living BRAIN preserves durable recall and extracted learnings
    +--> nexus and `nexus.share.*` extend cross-project reach
    |
    v
The Proving returns a LAFS-shaped result with preserved context and fewer heroic guesses
```

---

## 7. Character Sheet

| Character | Function | Personality |
|-----------|----------|-------------|
| **CLEO** | Governs continuity and coordination | Calm, exacting, remembers receipts |
| **BRAIN** | Keeps durable knowledge | Quiet, impossible to gaslight |
| **LOOM** | Keeps order of operations | Patient, allergic to chaos |
| **NEXUS** | Connects projects and patterns | Strategic, always sees the wider map |
| **LAFS** | Makes outputs understandable everywhere | Diplomatic, hates ambiguous payloads |
| **CAAMP** | Supplies the camp and configures the expedition | Practical, overprepared, suspicious of broken YAML |

One line worth keeping:

**If an agent returns pure vibes instead of structure, LAFS sends it back to fill out the proper forms, and CAAMP checks whether it packed the right tools in the first place.**

---

## 8. Canon In One Sentence

```text
CLEO rules the work, BRAIN remembers it, LOOM frames it,
NEXUS connects it, LAFS makes it legible, and CAAMP keeps the camp ready.
```
