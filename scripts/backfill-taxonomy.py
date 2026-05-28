#!/usr/bin/env python3
"""
Taxonomy label backfill script (T11186).

Normalizes ad-hoc labels in tasks.labels_json and brain_decisions.type
to canonical taxonomy tags.

Usage:
  python3 scripts/backfill-taxonomy.py --dry-run        # preview changes only
  python3 scripts/backfill-taxonomy.py                   # apply changes
  python3 scripts/backfill-taxonomy.py --tasks-only      # only tasks
  python3 scripts/backfill-taxonomy.py --brain-only      # only brain

@task T11186
@saga T10516
"""

import json, os, sqlite3, sys
from collections import OrderedDict

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TASKS_DB = os.path.join(PROJECT_ROOT, '.cleo', 'tasks.db')
BRAIN_DB = os.path.join(PROJECT_ROOT, '.cleo', 'brain.db')

# ============================================================================
# Ad-hoc → canonical tag mapping
# ============================================================================
ADHOC_MAP = {
    # Domain tags
    'architecture': 'architecture', 'architectural': 'architectural',
    'cli': 'cli', 'core': 'core', 'pm-core-v2': 'core', 'foundation': 'core',
    'contracts': 'contracts', 'schema': 'contracts',
    'caamp': 'caamp', 'cant': 'caamp', 'pi': 'caamp', 'cant-dsl': 'caamp',
    'skills': 'skills', 'brain': 'brain', 'nexus': 'nexus',
    'orchestration': 'orchestration', 'orchestrate': 'orchestration',
    'sessions': 'sessions', 'tasks': 'tasks',
    'docs': 'docs', 'documentation': 'docs',
    'cleoos': 'cleoos', 'facade': 'cleoos', 'sentient': 'cleoos',
    'worktrunk': 'worktrunk', 'worktrunk-ssot': 'worktrunk',
    'agents': 'agents', 'routing': 'routing', 'studio': 'studio',
    # Type tags
    'technical': 'technical', 'process': 'process',
    'strategic': 'strategic', 'tactical': 'tactical', 'operational': 'operational',
    'bugfix': 'bugfix', 'bug-fix': 'bugfix', 'hygiene': 'bugfix',
    'refactor': 'refactor', 'feature': 'feature',
    'discovery': 'discovery', 'exploration': 'discovery', 'research-type': 'discovery',
    'migration': 'migration', 'migrations': 'migration',
    'unification': 'unification', 'bootstrap': 'bootstrap',
    'openprose': 'discovery',
    # Lifecycle tags
    'research': 'research', 'wave-0': 'research',
    'consensus': 'consensus',
    'design': 'design', 'architecture_decision': 'design',
    'specification': 'specification', 'spec': 'specification', 'rfc': 'specification',
    'decomposition': 'decomposition',
    'implementation': 'implementation',
    'wave-1': 'implementation', 'wave-2': 'implementation', 'wave-3': 'implementation',
    'wave-4': 'implementation', 'wave-5': 'implementation',
    'wave.1': 'implementation', 'wave.2': 'implementation', 'wave.3': 'implementation',
    'validation': 'validation', 'testing': 'validation',
    'release': 'release',
    # Priority
    'p0': 'p0', 'critical': 'p0', 'prime-tier1': 'p0',
    'p1': 'p1', 'p2': 'p2', 'p3': 'p3',
    # Doc-kinds
    'adr': 'adr', 'handoff': 'handoff', 'note': 'note',
    'llmreadme': 'llmreadme', 'llm-readme': 'llmreadme',
    'designmd': 'designmd', 'design-md': 'designmd',
    'changeset': 'changeset', 'changelog': 'changelog',
}

import re
SKIP_RE = re.compile(
    r'^(t\d{4,6}|'
    r'\d+|'
    r'[a-f0-9]{64}|'
    r'subt(ask)?|'
    r'sg-template-config-ssot|'
    r't-csl-reset|'
    r'tg-.*|'
    r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|'
    r't\d{4,6}-.*)$',
    re.IGNORECASE,
)

def normalize_label(label):
    """Normalize a single label to canonical form."""
    s = str(label)
    if SKIP_RE.match(s):
        return s
    return ADHOC_MAP.get(s, s)

def normalize_labels(labels):
    """Normalize a JSON array of labels, deduplicate, sort."""
    if not isinstance(labels, list):
        return labels
    result = sorted(set(normalize_label(l) for l in labels))
    return result

# ============================================================================
# Tasks backfill
# ============================================================================
def backfill_tasks(dry_run):
    if not os.path.exists(TASKS_DB):
        print("tasks.db not found, skipping.")
        return

    conn = sqlite3.connect(TASKS_DB)
    rows = conn.execute(
        "SELECT id, title, labels_json FROM tasks "
        "WHERE labels_json != '[]' AND status != 'archived' ORDER BY id"
    ).fetchall()

    if not rows:
        print("No tasks with labels found.")
        conn.close()
        return

    changed, unchanged = 0, 0
    preview = []

    for row_id, title, labels_json in rows:
        try:
            labels = json.loads(labels_json)
        except (json.JSONDecodeError, TypeError):
            unchanged += 1
            continue

        if not isinstance(labels, list) or len(labels) == 0:
            unchanged += 1
            continue

        normalized = normalize_labels(labels)
        original_sorted = sorted(labels)

        if normalized == original_sorted:
            unchanged += 1
            continue

        changed += 1
        if len(preview) < 20:
            preview.append((row_id, title, labels, normalized))

        if not dry_run:
            conn.execute(
                "UPDATE tasks SET labels_json = ? WHERE id = ?",
                (json.dumps(normalized), row_id),
            )

    if not dry_run:
        conn.commit()
    conn.close()

    print(f"Total: {changed + unchanged} | Changed: {changed} | Unchanged: {unchanged}")
    for row_id, title, before, after in preview:
        print(f'  {row_id} "{title[:60]}"')
        print(f'    before: [{", ".join(before)}]')
        print(f'    after:  [{", ".join(after)}]')

# ============================================================================
# Brain decisions backfill
# ============================================================================
def backfill_brain(dry_run):
    if not os.path.exists(BRAIN_DB):
        print("brain.db not found, skipping.")
        return

    conn = sqlite3.connect(BRAIN_DB)
    rows = conn.execute(
        "SELECT id, type, substr(decision, 1, 80) FROM brain_decisions ORDER BY id"
    ).fetchall()

    if not rows:
        print("No brain decisions found.")
        conn.close()
        return

    changed, unchanged = 0, 0
    preview = []

    for row_id, dtype, decision in rows:
        canonical = normalize_label(dtype)
        if canonical == dtype:
            unchanged += 1
            continue

        changed += 1
        if len(preview) < 20:
            preview.append((row_id, decision, dtype, canonical))

        if not dry_run:
            conn.execute(
                "UPDATE brain_decisions SET type = ? WHERE id = ?",
                (canonical, row_id),
            )

    if not dry_run:
        conn.commit()
    conn.close()

    print(f"Total: {changed + unchanged} | Changed: {changed} | Unchanged: {unchanged}")
    for row_id, decision, before, after in preview:
        print(f'  {row_id} "{decision}"')
        print(f'    before: {before} → after: {after}')

# ============================================================================
# Main
# ============================================================================
def main():
    args = sys.argv[1:]
    dry_run = '--dry-run' in args
    tasks_only = '--tasks-only' in args
    brain_only = '--brain-only' in args

    print(f"Taxonomy backfill (T11186){' [DRY RUN]' if dry_run else ''}")
    print("=" * 60)

    if not brain_only:
        backfill_tasks(dry_run)

    if not tasks_only:
        backfill_brain(dry_run)

    if dry_run:
        print("\nDRY RUN — no changes applied. Remove --dry-run to apply.")
    else:
        print("\nBackfill complete.")

if __name__ == '__main__':
    main()
