#!/usr/bin/env python3
"""Resume large dogfood project generation — faster path using SQL for saga linking.
Target: 55 epics (47 done), 550 tasks (none yet)."""

import subprocess
import sys
import os
import json
import time
import shutil
import sqlite3

PROJECT_DIR = "/tmp/cleo-dogfood-large"
NUM_EPICS = 55
TASKS_PER_EPIC = 10
SAGA_ID = "T001"
CLEO = "cleo"

epic_titles = [
    "Core Infrastructure", "API Layer", "Database Layer",
    "Authentication System", "Authorization Framework", "Logging Subsystem",
    "Monitoring Pipeline", "Alert System", "Notification Engine",
    "Email Service", "SMS Gateway", "Push Notifications",
    "WebSocket Layer", "GraphQL Endpoint", "REST API Versioning",
    "Rate Limiting", "Caching Strategy", "CDN Integration",
    "Storage Backend", "File Upload Service", "Image Processing",
    "Video Transcoding", "Search Index", "Analytics Engine",
    "Reporting Dashboard", "User Management", "Role-Based Access",
    "Audit Logging", "Compliance Module", "GDPR Tools",
    "Data Export", "Import Pipeline", "Backup System",
    "Disaster Recovery", "Load Balancer Config", "Service Mesh",
    "Container Registry", "CI/CD Pipeline", "Test Framework",
    "Performance Benchmarks", "Security Scanning", "Dependency Management",
    "Documentation Engine", "SDK Generation", "Client Libraries",
    "Plugin System", "Extension Registry", "Migration Tools",
    "Database Seeding", "Feature Flags", "A/B Testing",
    "Experimentation Platform", "Machine Learning Pipeline", "Model Serving",
    "Inference Cache",
]


def run(cmd, cwd=PROJECT_DIR, timeout=120):
    full = f"cd {cwd} && {CLEO} {cmd}"
    r = subprocess.run(full, shell=True, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        print(f"ERR [{r.returncode}]: {full[:150]}")
        print(f"  {r.stderr[:200]}")
    return r


def main():
    db_path = os.path.join(PROJECT_DIR, ".cleo", "tasks.db")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # 1. Check current state (exclude saga itself from epic count)
    cur = conn.execute("SELECT COUNT(*) as cnt FROM tasks WHERE type='epic' AND id != ?", (SAGA_ID,))
    epic_count = cur.fetchone()["cnt"]
    print(f"Current epics: {epic_count}/{NUM_EPICS}")

    cur = conn.execute("SELECT id FROM tasks WHERE type='epic' AND id != ? ORDER BY id", (SAGA_ID,))
    existing_epic_ids = [r["id"] for r in cur.fetchall()]
    print(f"Epic IDs: {existing_epic_ids[0]}...{existing_epic_ids[-1]} ({len(existing_epic_ids)})")

    # 2. Link all existing epics to saga via SQL if not already linked
    cur = conn.execute(
        "SELECT related_to FROM task_relations WHERE task_id=? AND relation_type='groups'",
        (SAGA_ID,)
    )
    linked_ids = {r["related_to"] for r in cur.fetchall()}
    unlinked = [eid for eid in existing_epic_ids if eid not in linked_ids]
    print(f"Linked to saga: {len(linked_ids)}, unlinked: {len(unlinked)}")

    if unlinked:
        for eid in unlinked:
            conn.execute(
                "INSERT INTO task_relations (task_id, related_to, relation_type) VALUES (?,?,?)",
                (SAGA_ID, eid, "groups")
            )
        conn.commit()
        print(f"  SQL-linked {len(unlinked)} epics to saga")

    # 3. Resume session
    print("\n=== Checking session ===")
    r = run("session status", timeout=10)
    if r.returncode != 0:
        r2 = run("session start --scope global --name Dogfood-Resume", timeout=10)

    # 4. Create remaining epics if needed
    if epic_count < NUM_EPICS:
        needed = NUM_EPICS - epic_count
        print(f"\n=== Creating {needed} remaining epics ===")
        for i in range(epic_count, NUM_EPICS):
            title = epic_titles[i] if i < len(epic_titles) else f"Subsystem Module {i+1}"
            desc = f"Epic for {title.lower()} - large dogfood validation"
            ac = f"10 subtasks for {title.lower()}|all subtasks complete|integration verified"

            r = run(
                f"add --type epic --title '{title}' "
                f"--description '{desc}' --acceptance '{ac}' --priority high"
            )
            if r.returncode != 0:
                print(f"FAILED to create epic '{title}'")
                sys.exit(1)
            data = json.loads(r.stdout)
            epic_id = (data["data"].get("created", [None])[0]
                       or data["data"].get("ids", [None])[0]
                       or data["data"].get("taskId")
                       or data["data"].get("id", ""))
            if epic_id:
                conn.execute(
                    "INSERT INTO task_relations (task_id, related_to, relation_type) VALUES (?,?,?)",
                    (SAGA_ID, epic_id, "groups")
                )
                existing_epic_ids.append(epic_id)
            if (i + 1) % 10 == 0:
                print(f"  {i+1}/{NUM_EPICS}")
        conn.commit()
        print(f"All {NUM_EPICS} epics created and linked.")

    # 5. Create tasks in batches
    print(f"\n=== Creating {NUM_EPICS * TASKS_PER_EPIC} tasks ===")
    total_tasks = 0
    for epic_idx, epic_id in enumerate(existing_epic_ids[:NUM_EPICS]):
        # Check if tasks already exist
        cur = conn.execute("SELECT COUNT(*) as cnt FROM tasks WHERE parent_id=?", (epic_id,))
        existing = cur.fetchone()["cnt"]
        if existing >= TASKS_PER_EPIC:
            total_tasks += existing
            continue

        tasks = []
        for t in range(TASKS_PER_EPIC):
            ep_title = epic_titles[epic_idx] if epic_idx < len(epic_titles) else f"Module {epic_idx+1}"
            tasks.append({
                "title": f"Task {t+1}: Implement {ep_title} component {t+1}",
                "description": f"Implementation task {t+1} for epic {epic_id}",
                "acceptance": f"component {t+1} implemented|tests pass|reviewed",
                "priority": "medium",
                "kind": "work",
            })

        batch_file = f"/tmp/cleo-dogfood-batch-{epic_id}.json"
        with open(batch_file, "w") as f:
            json.dump(tasks, f, indent=2)

        r = run(f"add-batch --file {batch_file} --parent {epic_id}")
        if r.returncode != 0:
            print(f"Batch failed for {epic_id}: {r.stderr[:200]}")
            sys.exit(1)
        data = json.loads(r.stdout)
        created = data["data"].get("created", 0)
        total_tasks += created

        if (epic_idx + 1) % 10 == 0:
            print(f"  Batch {epic_idx+1}/{NUM_EPICS}: {total_tasks} tasks")

    conn.close()

    # Verify
    print(f"\n=== VERIFY ===")
    r = run("sql -q 'SELECT COUNT(*) FROM tasks WHERE type=\"epic\"'")
    print(r.stdout.strip())
    r = run("sql -q 'SELECT COUNT(*) FROM tasks WHERE type=\"task\"'")
    print(r.stdout.strip())
    r = run("saga members T001 --json")
    print(f"Saga members: {r.stdout[:200]}")

    # Write summary
    summary = {
        "project": PROJECT_DIR,
        "sagaId": SAGA_ID,
        "sagaTitle": "Dogfood Large Test Saga",
        "epicCount": NUM_EPICS,
        "taskCount": total_tasks,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    sp = os.path.join(PROJECT_DIR, ".cleo", "dogfood-summary.json")
    with open(sp, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"\nSummary: {sp}")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
