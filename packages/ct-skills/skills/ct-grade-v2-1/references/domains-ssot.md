# CLEO Domains SSoT

10 canonical domains for A/B test construction and grade analysis.
Source: `docs/specs/CLEO-OPERATION-CONSTITUTION.md` + `src/dispatch/registry.ts`.

---

## Domain Summary

| Domain | Gateway | Tier-0 ops | Key purpose |
|--------|---------|-----------|-------------|
| `tasks` | query+mutate | show, list, find, exists, tree, add, update, complete, cancel, delete | Task CRUD, hierarchy, deps |
| `session` | query+mutate | status, list, show, history, decision.log, start, end, resume, gc | Session lifecycle |
| `memory` | query+mutate | (tier 1+) show, find, timeline, fetch, observe | Cognitive memory (brain.db) |
| `check` | query+mutate | schema, protocol, task, manifest, test.run | Validation and compliance |
| `pipeline` | query+mutate | stage.validate, stage.status, manifest.*, release.* | RCSD lifecycle, releases |
| `orchestrate` | query+mutate | status, next, ready, waves, spawn, spawn.execute | Multi-agent coordination |
| `tools` | query+mutate | skill.list, skill.show, skill.find, provider.list, issue.add.bug | Skills, providers |
| `admin` | query+mutate | version, health, dash, help, stats, grade, grade.list | Config, diagnostics |
| `nexus` | query+mutate | (tier 2) status, list, show, register, sync | Cross-project coordination |
| `sticky` | query+mutate | list, show, add, convert, archive, purge | Quick capture notes |

---

## Tier-0 Operations (A/B test defaults)

These are available without progressive disclosure. Use as the default test set.

### tasks (17 query + 15 mutate)

**Query (tier 0):**
- `show` — single task details
- `list` — tasks with filters (HEAVY — test against `find`)
- `find` — search tasks (LIGHTWEIGHT — preferred)
- `exists` — check task ID exists
- `tree` — hierarchy tree
- `blockers` — blocking deps
- `depends` — dependency graph
- `analyze` — task metrics
- `next` — suggest next task
- `plan` — composite planning view
- `relates` — related tasks
- `current` — currently active task

**Mutate (tier 0):**
- `add` — create task
- `update` — modify task
- `complete` — mark done
- `cancel` — cancel task
- `delete` — permanent remove
- `archive` — soft delete
- `restore` — restore from terminal
- `start` — begin working
- `stop` — stop working

### session (11 query + 8 mutate)

**Query (tier 0):**
- `status` — current session status
- `list` — list sessions
- `show` — session details
- `history` — session history
- `decision.log` — decision log
- `context.drift` — detect drift
- `handoff.show` — handoff data
- `briefing.show` — session-start context
- `find` — lightweight session discovery

**Mutate (tier 0):**
- `start` — begin new session
- `end` — end current session
- `resume` — resume suspended
- `suspend` — suspend without ending
- `gc` — garbage-collect stale
- `record.decision` — record decision
- `record.assumption` — record assumption

### admin (tier 0 subset)

**Query:**
- `version` — CLEO version
- `health` — system health
- `config.show` — configuration
- `stats` — project statistics
- `context` — project context
- `runtime` — runtime info
- `dash` — dashboard overview
- `log` — audit log
- `help` — progressive disclosure entry
- `doctor` — health check diagnostics

**Mutate:**
- `init` — initialize CLEO
- `config.set` — set config
- `backup` — create backup
- `sync` — synchronize data stores
- `cleanup` — clean stale data
- `fix` — auto-fix doctor checks
- `detect` — refresh project-context.json

### tools (tier 0 subset)

**Query:**
- `skill.list` — list installed skills
- `skill.show` — skill details
- `skill.find` — search skills
- `skill.dispatch` — dispatch execution
- `skill.verify` — verify skill
- `provider.list` — list providers
- `provider.detect` — detect providers

**Mutate:**
- `skill.install` — install skill
- `skill.enable` / `skill.disable` — toggle
- `skill.configure` — configure params
- `skill.refresh` — refresh catalog
- `provider.inject` — inject provider config

---

## For A/B Testing

### Recommended test operation sets

**Fast smoke test (5 ops):**
```
tasks.find, tasks.show, session.status, admin.dash, admin.health
```

**Standard parity test (15 ops):**
```
tasks.find, tasks.show, tasks.list, tasks.tree, tasks.plan,
session.status, session.list, session.briefing.show,
admin.dash, admin.health, admin.help, admin.stats,
tools.skill.list, tools.provider.list, admin.doctor
```

**Full tier-0 sweep (all tier-0 query ops across all domains):**
Use `--tier 0 --gateway query` flag in run_ab_test.py

---

## Known Token Cost Ranking

Ordered by typical output size (most expensive first):

1. `tasks.list` (no filter) — AVOID in agents, use `tasks.find`
2. `admin.help --tier 2` — large operation catalog
3. `memory.find` — FTS5 results
4. `tasks.plan` — composite view
5. `admin.dash` — multi-domain overview
6. `admin.doctor` — comprehensive health
7. `tasks.tree` — hierarchy visualization
8. `session.history` — session log
9. `tasks.find` (10 results) — standard discovery
10. `admin.stats` — aggregate counts
