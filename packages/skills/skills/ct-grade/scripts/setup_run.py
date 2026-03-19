#!/usr/bin/env python3
"""
setup_run.py — Set up an A/B test run directory and print the execution plan.

Usage:
    python setup_run.py --mode scenario --scenario s4 --interface both --runs 3 --output-dir ./ab_results/run-001

Outputs:
    - Creates run directory structure
    - Writes run-manifest.json
    - Prints step-by-step execution plan for Claude to follow
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone


VALID_MODES = ["scenario", "ab", "blind"]
VALID_SCENARIOS = ["s1", "s2", "s3", "s4", "s5", "all"]
VALID_INTERFACES = ["mcp", "cli", "both"]

SCENARIO_LABELS = {
    "s1": "Fresh Discovery",
    "s2": "Task Creation Hygiene",
    "s3": "Error Recovery",
    "s4": "Full Lifecycle",
    "s5": "Multi-Domain Analysis",
}

DEFAULT_DOMAINS = ["tasks", "session"]


def expand_scenarios(scenario_arg):
    if scenario_arg == "all":
        return ["s1", "s2", "s3", "s4", "s5"]
    return [s.strip() for s in scenario_arg.split(",") if s.strip() in SCENARIO_LABELS]


def expand_interfaces(interface_arg):
    if interface_arg == "both":
        return ["mcp", "cli"]
    return [interface_arg]


def create_dir(path):
    os.makedirs(path, exist_ok=True)
    return path


def main():
    parser = argparse.ArgumentParser(description="Set up a ct-grade A/B test run")
    parser.add_argument("--mode", default="scenario", choices=VALID_MODES)
    parser.add_argument("--scenario", default="all")
    parser.add_argument("--interface", default="both", choices=VALID_INTERFACES)
    parser.add_argument("--domains", default="tasks,session")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--project-dir", default=".")
    args = parser.parse_args()

    scenarios = expand_scenarios(args.scenario)
    interfaces = expand_interfaces(args.interface)
    domains = [d.strip() for d in args.domains.split(",")]

    if not scenarios:
        print(f"ERROR: No valid scenarios in '{args.scenario}'. Use: {', '.join(VALID_SCENARIOS)}", file=sys.stderr)
        sys.exit(1)

    run_dir = args.output_dir
    create_dir(run_dir)

    # For ab/blind mode, each domain is a "slot"
    slots = scenarios if args.mode == "scenario" else domains

    # Create directory structure
    for slot in slots:
        for iface in interfaces:
            arm_label = "arm-A" if iface == interfaces[0] else "arm-B"
            for run in range(1, args.runs + 1):
                slot_dir = os.path.join(run_dir, slot, f"run-{run:02d}", arm_label)
                create_dir(slot_dir)
                # Create placeholder timing.json
                timing = {
                    "arm": arm_label,
                    "interface": iface,
                    "slot": slot,
                    "run": run,
                    "executor_start": None,
                    "executor_end": None,
                    "executor_duration_seconds": None,
                    "total_tokens": None,
                    "duration_ms": None,
                }
                timing_path = os.path.join(slot_dir, "timing.json")
                with open(timing_path, "w") as f:
                    json.dump(timing, f, indent=2)

    # Write run-manifest.json
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "mode": args.mode,
        "scenarios": scenarios,
        "interfaces": interfaces,
        "domains": domains,
        "runs_per_configuration": args.runs,
        "project_dir": os.path.abspath(args.project_dir),
        "run_dir": os.path.abspath(run_dir),
        "arms": {
            "A": {"interface": interfaces[0], "label": f"{interfaces[0].upper()} interface"},
            "B": {"interface": interfaces[1] if len(interfaces) > 1 else interfaces[0],
                  "label": f"{interfaces[-1].upper()} interface"},
        },
        "slots": slots,
        "status": "setup_complete",
    }
    manifest_path = os.path.join(run_dir, "run-manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    # Print execution plan
    print(f"\n{'='*60}")
    print(f"ct-grade A/B Run Setup Complete")
    print(f"{'='*60}")
    print(f"Mode:       {args.mode}")
    print(f"Scenarios:  {', '.join(scenarios)}")
    print(f"Interfaces: {', '.join(interfaces)}")
    print(f"Runs each:  {args.runs}")
    print(f"Output:     {os.path.abspath(run_dir)}")
    print(f"{'='*60}\n")

    print("EXECUTION PLAN\n")
    print("Spawn each arm as a parallel Agent task in the same turn.\n")

    step = 1
    for slot in slots:
        slot_label = SCENARIO_LABELS.get(slot, slot)
        print(f"## Slot: {slot} — {slot_label}\n")
        for run in range(1, args.runs + 1):
            for idx, iface in enumerate(interfaces):
                arm_label = "arm-A" if idx == 0 else "arm-B"
                arm_dir = os.path.join(os.path.abspath(run_dir), slot, f"run-{run:02d}", arm_label)
                print(f"Step {step}: Spawn Agent — {arm_label} ({iface}) | slot={slot} | run={run}")
                print(f"  Agent file:  agents/scenario-runner.md")
                print(f"  SCENARIO:    {slot}")
                print(f"  INTERFACE:   {iface}")
                print(f"  OUTPUT_DIR:  {arm_dir}")
                print(f"  RUN_NUMBER:  {run}")
                print(f"  CRITICAL: Capture total_tokens + duration_ms from task notification")
                print(f"            and update {arm_dir}/timing.json immediately.\n")
                step += 1

            # After both arms complete for this run
            comp_dir = os.path.join(os.path.abspath(run_dir), slot, f"run-{run:02d}")
            print(f"Step {step}: Spawn blind-comparator Agent")
            print(f"  Agent file:  agents/blind-comparator.md")
            print(f"  OUTPUT_A:    {comp_dir}/arm-A/")
            print(f"  OUTPUT_B:    {comp_dir}/arm-B/")
            print(f"  SCENARIO:    {slot}")
            print(f"  OUTPUT_PATH: {comp_dir}/comparison.json\n")
            step += 1

    print(f"Step {step}: Aggregate token data")
    print(f"  python scripts/token_tracker.py --run-dir {os.path.abspath(run_dir)}\n")
    step += 1

    print(f"Step {step}: Generate final report")
    print(f"  python scripts/generate_report.py --run-dir {os.path.abspath(run_dir)} --mode {args.mode}\n")
    step += 1

    print(f"Step {step}: (Optional) Spawn analysis-reporter Agent for deep synthesis")
    print(f"  Agent file:  agents/analysis-reporter.md")
    print(f"  RUN_DIR:     {os.path.abspath(run_dir)}\n")

    print(f"{'='*60}")
    print(f"Manifest: {manifest_path}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
