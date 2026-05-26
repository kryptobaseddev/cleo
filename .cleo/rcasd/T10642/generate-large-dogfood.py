#!/usr/bin/env python3
"""Generate large synthetic dogfood project for CLEO T10642.
Target: 55 epics, 10 tasks each = 550 tasks (satisfies AC1: 50+ epics, 500+ tasks)."""

import subprocess
import sys
import os
import json
import time
import shutil

PROJECT_DIR = "/tmp/cleo-dogfood-large"
NUM_EPICS = 55
TASKS_PER_EPIC = 10
SAGA_TITLE = "Dogfood Large Test Saga"
CLEO_JS = "/mnt/projects/cleocode/packages/cleo/bin/cleo.js"


def run_cleo(cmd, cwd=PROJECT_DIR, check=True, timeout=120):
    """Run cleo via node in the given directory."""
    full_cmd = f"cd {cwd} && node {CLEO_JS} {cmd}"
    result = subprocess.run(
        full_cmd, shell=True, capture_output=True, text=True, timeout=timeout
    )
    if check and result.returncode != 0:
        print(f"ERROR [{result.returncode}]: {full_cmd[:150]}")
        print(f"STDERR: {result.stderr[:500]}")
        print(f"STDOUT: {result.stdout[:500]}")
        sys.exit(1)
    return result


def run_cleo_ok(cmd, cwd=PROJECT_DIR, timeout=120):
    """Run cleo, return parsed JSON, tolerate non-zero exit for session already started etc."""
    return run_cleo(cmd, cwd=cwd, check=True, timeout=timeout)


def main():
    # 1. Clean/create project directory
    if os.path.exists(PROJECT_DIR):
        shutil.rmtree(PROJECT_DIR)
    os.makedirs(PROJECT_DIR, exist_ok=True)

    # 2. Initialize CLEO project
    print("=== Initializing CLEO project ===")
    result = run_cleo_ok(f"init --name dogfood-large --yes", timeout=60)
    print(result.stdout[:300].strip())

    # 3. Start a session (required for mutations)
    print("\n=== Starting session ===")
    result = run_cleo_ok(f"session start --scope global --name Dogfood")
    print(result.stdout[:200].strip())

    # 4. Create the Saga
    print("\n=== Creating Saga ===")
    result = run_cleo_ok(
        f"saga create --title '{SAGA_TITLE}' "
        f"--description 'Large-scale dogfood validation saga' "
        f"--acceptance '50+ epics|500+ tasks|graph validate|rollup performance'"
    )
    saga_data = json.loads(result.stdout)
    if not saga_data.get("success"):
        print(f"Saga creation failed: {result.stdout}")
        sys.exit(1)
    saga_id = saga_data["data"]["sagaId"]
    print(f"Saga created: {saga_id}")

    # 5. Create epics
    print(f"\n=== Creating {NUM_EPICS} epics ===")
    epic_ids = []
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

    for i in range(NUM_EPICS):
        title = epic_titles[i] if i < len(epic_titles) else f"Subsystem Module {i+1}"
        desc = f"Epic for {title.lower()} - large dogfood validation"
        ac = f"10 subtasks for {title.lower()}|all subtasks complete|integration verified"

        result = run_cleo_ok(
            f"add --type epic --title '{title}' "
            f"--description '{desc}' --acceptance '{ac}' --priority high"
        )
        data = json.loads(result.stdout)
        if not data.get("success"):
            print(f"Epic creation failed for '{title}': {data}")
            sys.exit(1)

        epic_id = data["data"].get("taskId") or data["data"].get("id", "")
        if not epic_id:
            print(f"Could not extract epic ID: {data}")
            sys.exit(1)

        epic_ids.append(epic_id)

        # Add epic to saga
        saga_add = run_cleo_ok(f"saga add {saga_id} {epic_id}")
        saga_add_data = json.loads(saga_add.stdout)
        if not saga_add_data.get("success"):
            print(f"  Warning: saga add {epic_id}: {saga_add.stdout[:100]}")
        else:
            pass  # success

        if (i + 1) % 10 == 0:
            print(f"  {i+1}/{NUM_EPICS} epics created...")

    print(f"All {len(epic_ids)} epics created.")

    # 6. Create tasks in batches per epic
    print(f"\n=== Creating {NUM_EPICS * TASKS_PER_EPIC} tasks ===")
    total_tasks = 0

    for epic_idx, epic_id in enumerate(epic_ids):
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

        result = run_cleo_ok(f"add-batch --file {batch_file} --parent {epic_id}")
        data = json.loads(result.stdout)
        if not data.get("success"):
            print(f"Batch create failed for epic {epic_id}: {data}")
            sys.exit(1)

        created = data["data"].get("created", 0)
        total_tasks += created

        if (epic_idx + 1) % 10 == 0:
            print(f"  Batch {epic_idx+1}/{NUM_EPICS}: {total_tasks} tasks so far...")

    print(f"\n=== COMPLETE ===")
    print(f"Project: {PROJECT_DIR}")
    print(f"Saga: {saga_id}")
    print(f"Epics: {len(epic_ids)}")
    print(f"Tasks: {total_tasks}")

    # Write summary
    summary = {
        "project": PROJECT_DIR,
        "sagaId": saga_id,
        "sagaTitle": SAGA_TITLE,
        "epicCount": len(epic_ids),
        "taskCount": total_tasks,
        "epicIds": epic_ids,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    summary_path = os.path.join(PROJECT_DIR, ".cleo", "dogfood-summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    print(f"Summary: {summary_path}")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
