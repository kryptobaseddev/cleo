<!-- Merged from the ct-memory skill into ct-cleo (T12649, D11157). -->

# Memory (BRAIN) — progressive recall

## Purpose

Ensures LLM agents never start conversations with amnesia. Provides structured memory access through CLEO's brain system using progressive disclosure.

## Tier 0: Session Start (ALWAYS run on first interaction)

Use CLI (`cleo`) for all memory operations.

1. `cleo briefing` (or `cleo memory digest`) gives the live project memory summary.
   The file bridge (`.cleo/memory-bridge.md`) is a legacy opt-in
   (`brain.memoryBridge.mode = "file"`); do not assume it was loaded.
2. For the task at hand, search:
   - `cleo memory find "session task decision" --limit 10`
3. Check for anti-patterns to avoid:
   - `cleo memory find "mistake error avoid warning" --limit 5`
4. If results are relevant, fetch details:
   - `cleo memory fetch O-xxx O-yyy`

## Tier 1: During Work (run when topic-relevant)

### Before Making Decisions

- `cleo memory find "decision ADR architecture" --limit 5`
- Check if a similar decision was already made

### Before Repeating Work

- `cleo memory find "{current-topic}" --limit 10`
- Avoid re-doing work that's already been completed

### After Completing Significant Work

- `cleo memory observe "Completed X using approach Y. Key learning: Z" --title "Work completion"`

### Anti-Hallucination Protocol

Before stating facts about the codebase or project:

1. Search brain:
   - `cleo memory find "{claim-topic}" --limit 5`
2. If results exist, verify your claim matches stored knowledge
3. If no results, state your uncertainty clearly

## Tier 2: Deep Recall (run when specifically needed)

### Full Timeline

- `cleo memory timeline O-xxx --before 5 --after 5`
- Understand chronological context around a specific observation

### Cross-Project Knowledge (via NEXUS)

- `cleo nexus search "pattern"` (add `--project <id>` to narrow to one project)
- Search the symbol graph across CLEO-managed projects

## Token Budget Guidelines

| Operation | ~Tokens | When |
|-----------|---------|------|
| `cleo memory digest` | 200-400 | Session start |
| `cleo memory find` | 50/hit | Discovery |
| `cleo memory fetch` | 500/entry | Details |
| `cleo memory timeline` | 200-500 | Context |

Stay within LAFS MVI budget: start minimal, escalate only when needed.
