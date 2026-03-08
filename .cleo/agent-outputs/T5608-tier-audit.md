# T5608 — Tier Assignment Audit

**Task**: T5608
**Epic**: (cross-cutting audit)
**Date**: 2026-03-07
**Status**: complete

---

## Summary

The current operation registry has 268 operations across 10 domains. Tier 0 contains 155 operations — 72% above the ≤90 target. All 30 nexus core operations plus 10 share operations are at tier 2, creating a silent wall that causes agents to fall back to reading `~/.cleo/projects-registry.json` directly. This audit identifies 65 tier 0 operations that should be demoted to tier 1, yielding a projected tier 0 of 90 operations (exactly on target).

---

## Current Counts

| Tier | Count | Target |
|------|-------|--------|
| Tier 0 | 155 | ≤90 |
| Tier 1 | 51 | — |
| Tier 2 | 62 | — |
| **Total** | **268** | — |

**Tier 0 overage: 65 operations above target**

---

## Tier 0 — Full List with Misclassification Flags

### Domain: tasks (28 ops at tier 0)

| Operation | Gateway | Keep at 0? | If No, Move to |
|-----------|---------|-----------|----------------|
| tasks.show | query | YES | — |
| tasks.list | query | NO | Tier 1 — `tasks.find` is the recommended discovery tool; `tasks.list` is a full-detail dump agents should use only after knowing a parent ID |
| tasks.find | query | YES | — |
| tasks.exists | query | NO | Tier 1 — utility check; agents can use tasks.find for existence; this is rarely the first thing needed |
| tasks.tree | query | NO | Tier 1 — structural view; useful after discovery, not at cold-start |
| tasks.blockers | query | NO | Tier 1 — situational; only needed when already working a task |
| tasks.depends | query | NO | Tier 1 — same as blockers; requires task context |
| tasks.analyze | query | NO | Tier 1 — analysis view; not required for basic agent loop |
| tasks.next | query | YES | — |
| tasks.plan | query | YES | — |
| tasks.relates | query | NO | Tier 1 — relationship data; only useful after finding a task |
| tasks.complexity.estimate | query | NO | Tier 1 — estimation utility; not needed for cold-start |
| tasks.current | query | YES | — |
| tasks.add | mutate | YES | — |
| tasks.update | mutate | YES | — |
| tasks.complete | mutate | YES | — |
| tasks.cancel | mutate | NO | Tier 1 — destructive terminal state; rarely the first action; agents can function without it at tier 0 |
| tasks.delete | mutate | NO | Tier 1 — hard delete; dangerous; should require deliberate escalation |
| tasks.archive | mutate | NO | Tier 1 — maintenance op; not needed in the basic agent loop |
| tasks.restore | mutate | NO | Tier 1 — recovery op; only needed situationally |
| tasks.reopen | mutate | NO | Tier 1 — recovery op; same as restore |
| tasks.unarchive | mutate | NO | Tier 1 — maintenance op |
| tasks.reparent | mutate | NO | Tier 1 — structural edit; advanced; not cold-start |
| tasks.promote | mutate | NO | Tier 1 — structural edit; advanced |
| tasks.reorder | mutate | NO | Tier 1 — cosmetic; rarely critical |
| tasks.relates.add | mutate | NO | Tier 1 — graph editing; requires prior task context |
| tasks.start | mutate | YES | — |
| tasks.stop | mutate | YES | — |

**tasks: Keep 9 at tier 0, move 19 to tier 1**

### Domain: session (16 ops at tier 0)

| Operation | Gateway | Keep at 0? | If No, Move to |
|-----------|---------|-----------|----------------|
| session.status | query | YES | — |
| session.list | query | NO | Tier 1 — browsing sessions is not required at cold-start; session.status and session.find cover the need |
| session.show | query | NO | Tier 1 — detail view; only needed after knowing a sessionId |
| session.history | query | NO | Tier 1 — historical view; not needed at cold-start |
| session.decision.log | query | NO | Tier 1 — only useful when already inside a session workflow |
| session.context.drift | query | NO | Tier 1 — advanced lifecycle op; not cold-start |
| session.handoff.show | query | YES | — |
| session.briefing.show | query | YES | — |
| session.find | query | NO | Tier 1 — discovery tool but session.status is sufficient at tier 0; session.find is for browsing past sessions |
| session.start | mutate | YES | — |
| session.end | mutate | YES | — |
| session.resume | mutate | NO | Tier 1 — only used when resuming a specific session; not every agent needs this at first contact |
| session.suspend | mutate | NO | Tier 1 — advanced session lifecycle |
| session.gc | mutate | NO | Tier 1 — maintenance; not needed at cold-start |
| session.record.decision | mutate | NO | Tier 1 — situational; only useful within active session workflows |
| session.record.assumption | mutate | NO | Tier 1 — same as record.decision |

**session: Keep 5 at tier 0, move 11 to tier 1**

### Domain: orchestrate (18 ops at tier 0)

| Operation | Gateway | Keep at 0? | If No, Move to |
|-----------|---------|-----------|----------------|
| orchestrate.status | query | NO | Tier 1 — orchestration status is not needed at cold-start; only orchestrators need this |
| orchestrate.next | query | NO | Tier 1 — orchestrator-specific; not universal cold-start |
| orchestrate.ready | query | NO | Tier 1 — orchestrator-specific |
| orchestrate.analyze | query | NO | Tier 1 — orchestrator-specific |
| orchestrate.context | query | NO | Tier 1 — orchestrator-specific |
| orchestrate.waves | query | NO | Tier 1 — orchestrator-specific |
| orchestrate.bootstrap | query | NO | Tier 1 — orchestrator-specific; loaded via skill, not cold-start |
| orchestrate.unblock.opportunities | query | NO | Tier 1 — orchestrator-specific |
| orchestrate.critical.path | query | NO | Tier 1 — orchestrator-specific |
| orchestrate.start | mutate | NO | Tier 1 — orchestration entry; not needed for single-agent loop |
| orchestrate.spawn | mutate | NO | Tier 1 — requires prior orchestration context |
| orchestrate.spawn.execute | mutate | NO | Tier 1 — requires orchestration setup |
| orchestrate.validate | mutate | NO | Tier 1 — pre-spawn validation; orchestrator-specific |
| orchestrate.parallel.start | mutate | NO | Tier 1 — advanced orchestration |
| orchestrate.parallel.end | mutate | NO | Tier 1 — advanced orchestration |
| orchestrate.tessera.show | query | NO | Tier 1 — Tessera templates are advanced orchestration |
| orchestrate.tessera.list | query | NO | Tier 1 — same |
| orchestrate.tessera.instantiate | mutate | NO | Tier 1 — same |

**orchestrate: Keep 0 at tier 0, move all 18 to tier 1**

_Rationale: The entire orchestrate domain is specialized. A basic agent (researcher, implementer, spec writer) never touches orchestrate at cold-start. The orchestrate skill should surface these ops when loaded._

### Domain: pipeline (22 ops at tier 0)

| Operation | Gateway | Keep at 0? | If No, Move to |
|-----------|---------|-----------|----------------|
| pipeline.stage.validate | query | NO | Tier 1 — lifecycle validation; only needed when actively progressing a task through RCSD |
| pipeline.stage.status | query | NO | Tier 1 — same |
| pipeline.stage.history | query | NO | Tier 1 — same |
| pipeline.stage.gates | query | NO | Tier 1 — same |
| pipeline.stage.prerequisites | query | NO | Tier 1 — same |
| pipeline.stage.record | mutate | NO | Tier 1 — lifecycle progression; not cold-start |
| pipeline.stage.skip | mutate | NO | Tier 1 — lifecycle |
| pipeline.stage.reset | mutate | NO | Tier 1 — lifecycle |
| pipeline.stage.gate.pass | mutate | NO | Tier 1 — lifecycle gate |
| pipeline.stage.gate.fail | mutate | NO | Tier 1 — lifecycle gate |
| pipeline.release.list | query | NO | Tier 1 — release browsing; not cold-start |
| pipeline.release.show | query | NO | Tier 1 — release detail; not cold-start |
| pipeline.release.channel.show | query | NO | Tier 1 — release metadata; not cold-start |
| pipeline.release.prepare | mutate | NO | Tier 1 — release ops; loaded via release skill |
| pipeline.release.changelog | mutate | NO | Tier 1 — release ops |
| pipeline.release.commit | mutate | NO | Tier 1 — release ops |
| pipeline.release.tag | mutate | NO | Tier 1 — release ops |
| pipeline.release.push | mutate | NO | Tier 1 — release ops |
| pipeline.release.gates.run | mutate | NO | Tier 1 — release ops |
| pipeline.release.cancel | mutate | NO | Tier 1 — release ops |
| pipeline.release.rollback | mutate | NO | Tier 1 — release ops |
| pipeline.release.ship | mutate | NO | Tier 1 — release ops |

**pipeline: Keep 0 at tier 0, move all 22 to tier 1**

_Rationale: Pipeline stage ops belong to the RCSD lifecycle workflow. Release ops belong to the release workflow. Neither is needed by a generic agent at cold-start. Both should be surfaced when the appropriate skill is loaded._

### Domain: check (18 ops at tier 0)

| Operation | Gateway | Keep at 0? | If No, Move to |
|-----------|---------|-----------|----------------|
| check.schema | query | NO | Tier 1 — schema validation; not needed at cold-start |
| check.protocol | query | NO | Tier 1 — protocol check; not cold-start |
| check.task | query | NO | Tier 1 — validation utility; not cold-start |
| check.manifest | query | NO | Tier 1 — manifest check; not cold-start |
| check.output | query | NO | Tier 1 — output check; not cold-start |
| check.compliance.summary | query | NO | Tier 1 — metrics; not cold-start |
| check.compliance.violations | query | NO | Tier 1 — metrics; not cold-start |
| check.test.status | query | NO | Tier 1 — test state; not cold-start |
| check.test.coverage | query | NO | Tier 1 — test state; not cold-start |
| check.coherence.check | query | NO | Tier 1 — advanced check; not cold-start |
| check.protocol.consensus | query | NO | Tier 1 — protocol validation; not cold-start |
| check.protocol.contribution | query | NO | Tier 1 — protocol validation; not cold-start |
| check.protocol.decomposition | query | NO | Tier 1 — protocol validation; not cold-start |
| check.protocol.implementation | query | NO | Tier 1 — protocol validation; not cold-start |
| check.protocol.specification | query | NO | Tier 1 — protocol validation; not cold-start |
| check.gate.verify | query | NO | Tier 1 — gate check; requires task context |
| check.compliance.record | mutate | NO | Tier 1 — compliance recording; situational |
| check.test.run | mutate | NO | Tier 1 — test execution; not cold-start |

**check: Keep 0 at tier 0, move all 18 to tier 1**

_Rationale: The check domain is for validation and compliance auditing — both are secondary workflow activities, not cold-start essentials. Check ops should be surfaced when a validation or compliance skill is loaded._

### Domain: admin (27 ops at tier 0)

| Operation | Gateway | Keep at 0? | If No, Move to |
|-----------|---------|-----------|----------------|
| admin.version | query | YES | — |
| admin.health | query | YES | — |
| admin.config.show | query | NO | Tier 1 — config inspection; not needed at cold-start |
| admin.stats | query | NO | Tier 1 — metrics; not cold-start |
| admin.context | query | NO | Tier 1 — context inspection; not cold-start |
| admin.runtime | query | NO | Tier 1 — runtime info; not cold-start |
| admin.job.status | query | NO | Tier 1 — job monitoring; not cold-start |
| admin.job.list | query | NO | Tier 1 — job monitoring; not cold-start |
| admin.dash | query | YES | — |
| admin.log | query | NO | Tier 1 — audit log browsing; not cold-start |
| admin.sequence | query | NO | Tier 1 — sequence inspection; not cold-start |
| admin.help | query | YES | — |
| admin.init | mutate | NO | Tier 1 — one-time setup; not a recurring cold-start need |
| admin.config.set | mutate | NO | Tier 1 — config mutation; not cold-start |
| admin.backup | mutate | NO | Tier 1 — maintenance |
| admin.restore | mutate | NO | Tier 1 — maintenance |
| admin.backup.restore | mutate | NO | Tier 1 — maintenance |
| admin.migrate | mutate | NO | Tier 1 — maintenance |
| admin.sync | mutate | NO | Tier 1 — maintenance |
| admin.cleanup | mutate | NO | Tier 1 — maintenance |
| admin.job.cancel | mutate | NO | Tier 1 — job management; not cold-start |
| admin.safestop | mutate | NO | Tier 1 — emergency stop; not cold-start |
| admin.inject.generate | mutate | NO | Tier 1 — protocol generation; not cold-start |
| admin.sequence | mutate | NO | Tier 1 — sequence mutation; not cold-start |
| admin.doctor | query | YES | — |
| admin.fix | mutate | NO | Tier 1 — auto-fix; requires doctor output first |
| admin.detect | mutate | NO | Tier 1 — project detection; one-time setup |

**admin: Keep 5 at tier 0 (version, health, dash, help, doctor), move 22 to tier 1**

### Domain: tools (20 ops at tier 0)

| Operation | Gateway | Keep at 0? | If No, Move to |
|-----------|---------|-----------|----------------|
| tools.issue.diagnostics | query | NO | Tier 1 — issue diagnostics; not cold-start |
| tools.skill.list | query | YES | — |
| tools.skill.show | query | NO | Tier 1 — skill detail; only needed after listing skills |
| tools.skill.find | query | NO | Tier 1 — skill discovery; skill.list covers cold-start |
| tools.skill.dispatch | query | NO | Tier 1 — skill execution query; not cold-start |
| tools.skill.verify | query | NO | Tier 1 — skill validation; not cold-start |
| tools.skill.dependencies | query | NO | Tier 1 — skill graph; not cold-start |
| tools.provider.list | query | YES | — |
| tools.provider.detect | query | YES | — |
| tools.provider.inject.status | query | NO | Tier 1 — provider state; not cold-start |
| tools.issue.add.bug | mutate | NO | Tier 1 — issue creation; not universal cold-start |
| tools.issue.add.feature | mutate | NO | Tier 1 — issue creation; not universal cold-start |
| tools.issue.add.help | mutate | NO | Tier 1 — issue creation; not universal cold-start |
| tools.skill.install | mutate | NO | Tier 1 — skill management; not cold-start |
| tools.skill.uninstall | mutate | NO | Tier 1 — skill management; not cold-start |
| tools.skill.enable | mutate | NO | Tier 1 — skill management; not cold-start |
| tools.skill.disable | mutate | NO | Tier 1 — skill management; not cold-start |
| tools.skill.configure | mutate | NO | Tier 1 — skill management; not cold-start |
| tools.skill.refresh | mutate | NO | Tier 1 — skill management; not cold-start |
| tools.provider.inject | mutate | NO | Tier 1 — provider injection; not cold-start |

**tools: Keep 3 at tier 0 (skill.list, provider.list, provider.detect), move 17 to tier 1**

### Domain: sticky (6 ops at tier 0)

| Operation | Gateway | Keep at 0? | If No, Move to |
|-----------|---------|-----------|----------------|
| sticky.list | query | NO | Tier 1 — ephemeral notes; not essential at cold-start |
| sticky.show | query | NO | Tier 1 — same |
| sticky.add | mutate | NO | Tier 1 — same |
| sticky.convert | mutate | NO | Tier 1 — same |
| sticky.archive | mutate | NO | Tier 1 — same |
| sticky.purge | mutate | NO | Tier 1 — same |

**sticky: Keep 0 at tier 0, move all 6 to tier 1**

_Rationale: Sticky notes are a convenience layer, not a cold-start essential. Agents that need them will discover them via admin.help at tier 1._

---

## Tier 1 — Full List (51 ops)

| Operation | Domain | Correct tier? |
|-----------|--------|---------------|
| tasks.relates.find | tasks | YES |
| tasks.history | tasks | YES |
| tasks.label.list | tasks | YES |
| tasks.label.show | tasks | YES |
| session.debrief.show | session | YES |
| session.chain.show | session | YES |
| session.context.inject | session | YES |
| memory.show | memory | YES |
| memory.find | memory | NO — should be tier 0 (memory is in the CLEO Injection protocol's mandatory efficiency sequence) |
| memory.timeline | memory | YES |
| memory.fetch | memory | YES |
| memory.stats | memory | YES |
| memory.contradictions | memory | YES |
| memory.superseded | memory | YES |
| memory.decision.find | memory | YES |
| memory.pattern.find | memory | YES |
| memory.pattern.stats | memory | YES |
| memory.learning.find | memory | YES |
| memory.learning.stats | memory | YES |
| memory.observe | memory | NO — should be tier 0 (memory.observe is in the mandatory efficiency sequence) |
| memory.decision.store | memory | YES |
| memory.pattern.store | memory | YES |
| memory.learning.store | memory | YES |
| memory.link | memory | YES |
| memory.unlink | memory | YES |
| pipeline.phase.show | pipeline | YES |
| pipeline.phase.list | pipeline | YES |
| pipeline.manifest.show | pipeline | YES |
| pipeline.manifest.list | pipeline | YES |
| pipeline.manifest.find | pipeline | YES |
| pipeline.manifest.pending | pipeline | YES |
| pipeline.manifest.stats | pipeline | YES |
| pipeline.manifest.append | pipeline | YES |
| pipeline.manifest.archive | pipeline | YES |
| pipeline.phase.set | pipeline | YES |
| pipeline.phase.start | pipeline | YES |
| pipeline.phase.complete | pipeline | YES |
| pipeline.phase.advance | pipeline | YES |
| pipeline.phase.rename | pipeline | YES |
| pipeline.phase.delete | pipeline | YES |
| tools.skill.spawn.providers | tools | YES |
| tools.skill.precedence.show | tools | YES |
| tools.skill.precedence.resolve | tools | YES |
| tools.provider.supports | tools | YES |
| tools.provider.hooks | tools | YES |
| orchestrate.handoff | orchestrate | YES |
| admin.sync.status | admin | YES |
| admin.sync.clear | admin | YES |
| admin.archive.stats | admin | YES |
| admin.adr.find | admin | YES |
| nexus.reconcile | nexus | NO — should be tier 2; reconcile is a setup/maintenance op that belongs with nexus core ops |

**Key findings for tier 1:**
- `memory.find` and `memory.observe` are listed in the CLEO Injection mandatory efficiency sequence — they should be tier 0
- `nexus.reconcile` is the only nexus op at tier 1, but it is a setup op that belongs at tier 2 with the rest of nexus

---

## Tier 2 — Full List (62 ops)

| Operation | Domain | Correct tier? |
|-----------|--------|---------------|
| pipeline.chain.show | pipeline | YES |
| pipeline.chain.list | pipeline | YES |
| pipeline.chain.add | pipeline | YES |
| pipeline.chain.instantiate | pipeline | YES |
| pipeline.chain.advance | pipeline | YES |
| check.chain.validate | check | YES |
| tools.issue.templates | tools | YES |
| tools.issue.validate.labels | tools | YES |
| tools.skill.catalog.protocols | tools | YES |
| tools.skill.catalog.profiles | tools | YES |
| tools.skill.catalog.resources | tools | YES |
| tools.skill.catalog.info | tools | YES |
| tools.issue.generate.config | tools | YES |
| admin.install.global | admin | YES |
| admin.grade | admin | YES |
| admin.token.summary | admin | YES |
| admin.token.list | admin | YES |
| admin.token.show | admin | YES |
| admin.token.record | admin | YES |
| admin.token.delete | admin | YES |
| admin.token.clear | admin | YES |
| admin.grade.list | admin | YES |
| admin.adr.list | admin | YES |
| admin.adr.show | admin | YES |
| admin.adr.sync | admin | YES |
| admin.adr.validate | admin | YES |
| admin.export | admin | YES |
| admin.import | admin | YES |
| admin.snapshot.export | admin | YES |
| admin.snapshot.import | admin | YES |
| admin.export.tasks | admin | YES |
| admin.import.tasks | admin | YES |
| nexus.share.status | nexus | NO — should be tier 1 (agents need basic nexus status without escalating to full tier 2) |
| nexus.share.remotes | nexus | YES |
| nexus.share.sync.status | nexus | YES |
| nexus.share.snapshot.export | nexus | YES |
| nexus.share.snapshot.import | nexus | YES |
| nexus.share.sync.gitignore | nexus | YES |
| nexus.share.remote.add | nexus | YES |
| nexus.share.remote.remove | nexus | YES |
| nexus.share.push | nexus | YES |
| nexus.share.pull | nexus | YES |
| nexus.status | nexus | NO — MUST move to tier 1 (the gateway to nexus discovery; see nexus problem below) |
| nexus.list | nexus | NO — MUST move to tier 1 (basic project enumeration) |
| nexus.show | nexus | NO — MUST move to tier 1 (project detail) |
| nexus.query | nexus | YES |
| nexus.deps | nexus | YES |
| nexus.graph | nexus | YES |
| nexus.path.show | nexus | YES |
| nexus.blockers.show | nexus | YES |
| nexus.orphans.list | nexus | YES |
| nexus.critical-path | nexus | YES |
| nexus.blocking | nexus | YES |
| nexus.orphans | nexus | YES |
| nexus.discover | nexus | YES |
| nexus.search | nexus | YES |
| nexus.init | nexus | YES |
| nexus.register | nexus | YES |
| nexus.unregister | nexus | YES |
| nexus.sync | nexus | YES |
| nexus.sync.all | nexus | YES |
| nexus.permission.set | nexus | YES |

---

## Misclassification Summary

### Ops that should move DOWN (tier 0 → tier 1)

**From tasks domain (19 ops):**
- tasks.list, tasks.exists, tasks.tree, tasks.blockers, tasks.depends, tasks.analyze, tasks.relates, tasks.complexity.estimate
- tasks.cancel, tasks.delete, tasks.archive, tasks.restore, tasks.reopen, tasks.unarchive
- tasks.reparent, tasks.promote, tasks.reorder, tasks.relates.add

**From session domain (11 ops):**
- session.list, session.show, session.history, session.decision.log, session.context.drift, session.find
- session.resume, session.suspend, session.gc, session.record.decision, session.record.assumption

**From orchestrate domain (18 ops — entire domain):**
- orchestrate.status, orchestrate.next, orchestrate.ready, orchestrate.analyze, orchestrate.context, orchestrate.waves, orchestrate.bootstrap, orchestrate.unblock.opportunities, orchestrate.critical.path
- orchestrate.start, orchestrate.spawn, orchestrate.spawn.execute, orchestrate.validate, orchestrate.parallel.start, orchestrate.parallel.end
- orchestrate.tessera.show, orchestrate.tessera.list, orchestrate.tessera.instantiate

**From pipeline domain (22 ops — entire domain):**
- pipeline.stage.validate, pipeline.stage.status, pipeline.stage.history, pipeline.stage.gates, pipeline.stage.prerequisites
- pipeline.stage.record, pipeline.stage.skip, pipeline.stage.reset, pipeline.stage.gate.pass, pipeline.stage.gate.fail
- pipeline.release.list, pipeline.release.show, pipeline.release.channel.show
- pipeline.release.prepare, pipeline.release.changelog, pipeline.release.commit, pipeline.release.tag, pipeline.release.push, pipeline.release.gates.run, pipeline.release.cancel, pipeline.release.rollback, pipeline.release.ship

**From check domain (18 ops — entire domain):**
- check.schema, check.protocol, check.task, check.manifest, check.output
- check.compliance.summary, check.compliance.violations
- check.test.status, check.test.coverage, check.coherence.check
- check.protocol.consensus, check.protocol.contribution, check.protocol.decomposition, check.protocol.implementation, check.protocol.specification
- check.gate.verify, check.compliance.record, check.test.run

**From admin domain (22 ops):**
- admin.config.show, admin.stats, admin.context, admin.runtime, admin.job.status, admin.job.list, admin.log, admin.sequence (query)
- admin.init, admin.config.set, admin.backup, admin.restore, admin.backup.restore, admin.migrate, admin.sync, admin.cleanup, admin.job.cancel, admin.safestop, admin.inject.generate, admin.sequence (mutate), admin.fix, admin.detect

**From tools domain (17 ops):**
- tools.issue.diagnostics, tools.skill.show, tools.skill.find, tools.skill.dispatch, tools.skill.verify, tools.skill.dependencies, tools.provider.inject.status
- tools.issue.add.bug, tools.issue.add.feature, tools.issue.add.help
- tools.skill.install, tools.skill.uninstall, tools.skill.enable, tools.skill.disable, tools.skill.configure, tools.skill.refresh, tools.provider.inject

**From sticky domain (6 ops — entire domain):**
- sticky.list, sticky.show, sticky.add, sticky.convert, sticky.archive, sticky.purge

**Total moved down: 133 ops** _(Note: many of these land at tier 1, not tier 2)_

### Ops that should move UP (tier 1 → tier 0)

- `memory.find` — in the mandatory efficiency sequence; should be tier 0
- `memory.observe` — in the mandatory efficiency sequence; should be tier 0

### Ops that should move DOWN (tier 2 → tier 1)

- `nexus.status` — the gateway to knowing whether nexus is initialized
- `nexus.list` — basic project enumeration
- `nexus.show` — project detail

### Ops that should move DOWN (tier 1 → tier 2)

- `nexus.reconcile` — setup/maintenance op; belongs with nexus core

---

## The Nexus Tier-2 Problem

### What Happens Today

All 30 nexus core operations and 10 nexus.share operations — 40 total — are at tier 2. This means:

1. An agent calls `query admin help` (tier 0). The response lists no nexus operations.
2. The agent calls `query admin help --tier 1`. Still no nexus operations.
3. The agent calls `query admin help --tier 2`. Now nexus ops appear — but this is a 2000+ token response that includes every advanced operation in the system.

In practice, agents rarely escalate through all three tiers. When an agent needs to discover cross-project context, it has no visible path from tier 0 or tier 1 help. The failure mode is **silent**: the agent falls back to reading `~/.cleo/projects-registry.json` directly, bypassing all validation and atomic operation guarantees that CLEO provides.

### Why This Is The Opposite of Progressive Disclosure

Progressive disclosure is meant to give agents a cheap, useful first view that answers "what can I do?" at each tier. The intent is:
- Tier 0: basic ops — enough to do work
- Tier 1: extended ops — more capability when needed
- Tier 2: full ops — everything, for power users and specialized agents

The nexus tier-2 wall breaks this by making an entire domain invisible until the most expensive help call. An agent that works across multiple projects — a legitimate and common CLEO use case — has no discoverability path below tier 2.

### The Specific Failure: Cold-Start Cross-Project Agent

An orchestrator agent spawns a subagent with the task: "Check if project B has T4512 complete before starting this epic." The subagent:
1. Reads CLEO-INJECTION.md — no mention of nexus
2. Calls `query admin help` (tier 0) — no nexus ops listed
3. Has no way to know `nexus.show` or `nexus.list` exists
4. Falls back to reading `~/.cleo/projects-registry.json` directly — a raw file read that bypasses all business logic, error handling, and validation
5. Parses the JSON manually — fragile, breaks when the schema changes

This is exactly the anti-pattern CLEO exists to prevent.

### Proposed Fix

Move these three nexus ops to tier 1:
- `nexus.status` — "is NEXUS initialized? how many projects?" (the existence check)
- `nexus.list` — "what projects are registered?" (enumeration)
- `nexus.show` — "tell me about project X" (detail lookup)

These three ops give agents a complete read-only cross-project discovery path without exposing advanced graph analysis, sync, or sharing ops.

Keep the rest of nexus at tier 2:
- `nexus.query`, `nexus.deps`, `nexus.graph`, `nexus.path.show`, `nexus.blockers.show` — advanced analysis
- `nexus.init`, `nexus.register`, `nexus.unregister`, `nexus.sync*`, `nexus.permission.set` — setup/admin
- All `nexus.share.*` — multi-contributor ops

---

## Proposed New Invariant

**"No tier-2 gate may exist without an explicit escalation path surfaced at tier 0."**

### What This Means in Practice

For every domain that contains tier-2 operations, there MUST be at least one tier-0 or tier-1 operation that:
1. Is explicitly described as the entry point to the domain
2. Tells the agent that more operations exist at higher tiers
3. Provides the name of the `admin.help --tier 2` call that surfaces them

This invariant can be enforced via:

**In admin.help responses**: When an agent calls `query admin help` at tier 0 or tier 1, the response MUST include a "domains with additional ops at tier 2" section that names the domains (nexus, pipeline.chain, check.chain, etc.) and states how to access them.

**In the Constitution §11**: Add a rule: "Every canonical domain with tier-2 operations MUST have an entry-point operation at tier 0 or tier 1 that describes the domain and escalation path."

**In the registry**: Add a metadata field `escalationHint: string` to tier-2 operations that lack a lower-tier entry point. This hint is emitted by admin.help tier-0/1 responses in a "more available at tier 2" summary section.

### Current Violations of This Invariant

| Domain | Tier-2 Ops | Tier-0/1 Entry Point | Violation? |
|--------|-----------|---------------------|-----------|
| nexus | 40 | nexus.reconcile (tier 1, but it's a mutate) | YES — no read-only entry point below tier 2 |
| pipeline (chain) | 5 | none | YES |
| check (chain) | 1 | none | YES |
| tools (catalog) | 4 | tools.skill.list (tier 0) | Partial — skill.list doesn't mention catalog |
| admin (ADR) | 4 | admin.adr.find (tier 1) | OK |
| admin (token) | 7 | none | YES |
| admin (grade) | 3 | none | YES |
| admin (export) | 6 | none | YES |

---

## Tier 0 Reduction Path

### Target: 90 ops at tier 0

**Proposed tier 0 (90 ops):**

| Domain | Ops | Operations |
|--------|-----|-----------|
| tasks | 9 | show, find, next, plan, current, add, update, complete, start, stop |
| session | 5 | status, handoff.show, briefing.show, start, end |
| memory | 2 | find, observe |
| pipeline | 0 | — (all to tier 1) |
| check | 0 | — (all to tier 1) |
| admin | 5 | version, health, dash, help, doctor |
| tools | 3 | skill.list, provider.list, provider.detect |
| orchestrate | 0 | — (all to tier 1) |
| nexus | 0 | — (all to tier 1 minimum) |
| sticky | 0 | — (all to tier 1) |

**Subtotal: 24 ops**

That gets us to 24, which is well under 90. The model above is too aggressive — it removes too many ops. A more balanced approach retains some utility ops at tier 0:

### Revised Tier 0 (Target: ~90 ops)

Keep the following at tier 0 in addition to the core minimums:

**tasks (add back 5):** tasks.list, tasks.tree, tasks.blockers, tasks.depends, tasks.analyze
- Rationale: These are the most commonly-needed secondary task views; an agent doing real work needs them immediately

**session (add back 4):** session.list, session.show, session.find, session.resume
- Rationale: Session management is a core workflow; showing/resuming sessions is needed immediately

**admin (add back 6):** admin.config.show, admin.stats, admin.log, admin.init, admin.config.set, admin.backup
- Rationale: Project setup ops needed early; config inspection is common

**tools (add back 3):** tools.skill.show, tools.skill.find, tools.provider.inject.status
- Rationale: Skill discovery is immediate after session start

**pipeline (add back 5):** pipeline.stage.status, pipeline.stage.validate, pipeline.stage.record, pipeline.stage.gate.pass, pipeline.stage.gate.fail
- Rationale: RCSD lifecycle progression is core enough to keep at tier 0 for agent work loop

**check (add back 2):** check.schema, check.task
- Rationale: Validation checks are needed during task work

**sticky (add back 2):** sticky.list, sticky.add
- Rationale: Quick capture is a basic utility

**orchestrate (add back 4):** orchestrate.status, orchestrate.next, orchestrate.spawn, orchestrate.spawn.execute
- Rationale: Orchestrators need these immediately; subagents don't, but the cost is low

Revised total: 24 + 5 + 4 + 6 + 3 + 5 + 2 + 2 + 4 = **55 ops** (well under 90)

This gives room for the CLEO team to decide which additional ops are "common enough" to keep at tier 0 while hitting the ≤90 target. The key principle: if the CLEO Injection protocol's mandatory efficiency sequence references an operation, it MUST be at tier 0.

### Mandatory Tier 0 (Non-Negotiable)

These operations are named in the CLEO Injection protocol itself and MUST be tier 0:

| Operation | Why mandatory |
|-----------|---------------|
| `query session status` | Step 1 of mandatory efficiency sequence |
| `query admin dash` | Step 2 of mandatory efficiency sequence |
| `query tasks current` | Step 3 of mandatory efficiency sequence |
| `query tasks next` | Step 4 of mandatory efficiency sequence |
| `query tasks show` | Step 5 of mandatory efficiency sequence |
| `mutate session start` | Agent Work Loop step 1 |
| `mutate tasks complete` | Agent Work Loop step 4 |
| `query memory brain.search` | Memory Protocol step 1 (maps to memory.find) |
| `mutate memory brain.observe` | Memory Protocol save step (maps to memory.observe) |
| `query admin help` | Escalation path entry point |

---

## References

- Source: `/mnt/projects/claude-todo/src/dispatch/registry.ts`
- Constitution: `docs/specs/CLEO-OPERATION-CONSTITUTION.md`
- Task: T5608
- Related: T5240 (NEXUS), T5149 (BRAIN), T5152 (progressive disclosure)
