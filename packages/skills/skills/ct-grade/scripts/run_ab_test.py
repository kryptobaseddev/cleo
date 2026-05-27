#!/usr/bin/env python3
"""
ct-grade v3 — Blind A/B test: CLEO MCP vs CLI for the same operations.

Side A = MCP JSON-RPC via stdio (node dist/mcp/index.js)
Side B = CLI subprocess (cleo-dev <domain> <operation>)

Randomly shuffles A/B assignment per run so the comparator is blind.

Usage:
    python run_ab_test.py --domain tasks --operations find,show,list [options]
    python run_ab_test.py --test-set parity [options]
    python run_ab_test.py --domain session --tier 0 [options]

Options:
    --domain          CLEO domain to test (tasks, session, admin, tools, etc.)
    --operations      Comma-separated operation names (e.g. find,show,list)
    --test-set        Predefined set: smoke, standard, parity-P1, parity-P2, parity-P3, parity
    --tier            Filter operations by tier (0, 1, 2)
    --gateway         query or mutate (default: query)
    --runs            Runs per operation (default: 3)
    --cleo            CLI binary (default: cleo-dev)
    --project-dir     Path to CLEO project root (for MCP server)
    --output-dir      Results directory
    --params-json     JSON string of params to pass to each operation
    --seed-task       Task ID to use in operations that need one
    --json            Print summary JSON to stdout
"""

import argparse
import json
import os
import random
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Operation sets
# ---------------------------------------------------------------------------

OPERATION_SETS = {
    "smoke": {
        # Fast default — 6 operations, ~2-3 min
        "tasks": ["find", "show"],
        "session": ["list", "status"],
        "admin": ["dash", "health"],
    },
    "standard": {
        "tasks": ["find", "show", "list", "tree", "plan"],
        "session": ["status", "list", "briefing.show"],
        "admin": ["dash", "health", "help", "stats"],
        "tools": ["skill.list", "provider.list"],
    },
    "parity-P1": {
        # P1: tasks domain query ops
        "tasks": ["find", "show", "list", "tree", "plan", "exists"],
    },
    "parity-P2": {
        # P2: session domain query ops
        "session": ["status", "list", "briefing.show", "handoff.show", "context.drift"],
    },
    "parity-P3": {
        # P3: admin domain query ops
        "admin": ["dash", "health", "help", "stats", "doctor"],
    },
    "parity": {
        # Full parity (P1+P2+P3 combined)
        "tasks": ["find", "show", "list", "tree", "plan", "exists"],
        "session": ["status", "list", "briefing.show", "handoff.show"],
        "admin": ["dash", "health", "help", "stats", "doctor"],
    },
}

# Operations that need a task ID in params
TASK_ID_OPS = {"show", "exists", "complete", "cancel", "archive", "restore",
               "start", "stop", "relates", "complexity.estimate", "history"}

# Map from domain.operation to CLI args builder
def build_cli_args(domain, operation, seed_task=None):
    """Build CLI argument list for a domain.operation call."""
    base = [domain]

    # Map dotted operations to CLI sub-commands
    op_parts = operation.split(".")
    base.extend(op_parts)

    # Add required params
    if operation in TASK_ID_OPS and seed_task:
        base.extend([seed_task])
    elif operation == "find":
        base.extend(["--query", "test"])
    elif operation == "label.show":
        base.extend(["--label", "bug"])
    elif operation == "help":
        pass  # no extra args

    return base


def build_mcp_payload(gateway, domain, operation, seed_task=None, extra_params=None):
    """Build MCP JSON-RPC tool call payload."""
    params = extra_params or {}
    if operation in TASK_ID_OPS and seed_task:
        params["taskId"] = seed_task
    elif operation == "find" and not params:
        params["query"] = "test"

    return {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": gateway,
            "arguments": {
                "domain": domain,
                "operation": operation,
                "params": params,
            }
        }
    }


MCP_INIT = {
    "jsonrpc": "2.0",
    "id": 0,
    "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "ct-grade-ab-test", "version": "2.1.0"}
    }
}


# ---------------------------------------------------------------------------
# Interface callers
# ---------------------------------------------------------------------------

def call_via_mcp(gateway, domain, operation, cleo_path, seed_task=None, extra_params=None):
    """Call CLEO via MCP stdio JSON-RPC. Returns (success, output_chars, duration_ms, response)."""
    payload = build_mcp_payload(gateway, domain, operation, seed_task, extra_params)
    messages = json.dumps(MCP_INIT) + "\n" + json.dumps(payload) + "\n"

    mcp_entry = Path(cleo_path) / "dist" / "mcp" / "index.js"
    if not mcp_entry.exists():
        return False, 0, 0, {"error": f"MCP server not found at {mcp_entry}"}

    start = time.time()
    try:
        proc = subprocess.run(
            ["node", str(mcp_entry)],
            input=messages,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(cleo_path),
        )
        duration_ms = int((time.time() - start) * 1000)
        output_chars = len(proc.stdout)

        # Find the tool call response (id=1)
        response = None
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
                if parsed.get("id") == 1:
                    response = parsed
                    break
            except Exception:
                continue

        stderr = proc.stderr or ""
        if "migration" in stderr.lower() or "ENOENT" in stderr or "tasks.db" in stderr.lower():
            return False, 0, duration_ms, {"error": "DB_UNAVAILABLE", "stderr": stderr[:200]}

        if response is None:
            return False, output_chars, duration_ms, {"error": "no response found", "raw": proc.stdout[:500]}

        success = "result" in response and "error" not in response
        return success, output_chars, duration_ms, response

    except subprocess.TimeoutExpired:
        return False, 0, 30000, {"error": "timeout"}
    except Exception as e:
        return False, 0, 0, {"error": str(e)}


def call_via_cli(domain, operation, cleo_bin, cwd=None, seed_task=None):
    """Call CLEO via CLI subprocess. Returns (success, output_chars, duration_ms, output)."""
    cli_args = build_cli_args(domain, operation, seed_task)
    cmd = [cleo_bin] + cli_args + ["--json"]

    start = time.time()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=cwd,
        )
        duration_ms = int((time.time() - start) * 1000)
        output_chars = len(proc.stdout)
        success = proc.returncode == 0

        try:
            parsed = json.loads(proc.stdout)
        except Exception:
            parsed = {"raw": proc.stdout[:500]}

        return success, output_chars, duration_ms, parsed

    except subprocess.TimeoutExpired:
        return False, 0, 30000, {"error": "timeout"}
    except Exception as e:
        return False, 0, 0, {"error": str(e)}


# ---------------------------------------------------------------------------
# Blind comparator
# ---------------------------------------------------------------------------

def blind_compare(output_a, output_b, operation, chars_a, chars_b, dur_a, dur_b):
    """
    Simple blind comparator. Returns dict with winner, reasoning, scores.
    In a real run, this would be delegated to an LLM comparator agent.
    Here we use heuristics: completeness, structure, token efficiency.
    """
    def score_response(resp, chars):
        score = 0
        # Completeness: has data?
        if isinstance(resp, dict):
            if resp.get("result") or resp.get("data") or resp.get("success"):
                score += 3
            if "error" not in resp:
                score += 2
        # Structure: is it clean JSON?
        score += 2
        # Token efficiency: smaller is better (same data)
        score += max(0, 3 - int(chars / 2000))
        return min(10, score)

    score_a = score_response(output_a, chars_a)
    score_b = score_response(output_b, chars_b)

    if score_a > score_b:
        winner = "A"
        reasoning = f"A scored higher ({score_a} vs {score_b}). Chars: {chars_a} vs {chars_b}."
    elif score_b > score_a:
        winner = "B"
        reasoning = f"B scored higher ({score_b} vs {score_a}). Chars: {chars_b} vs {chars_a}."
    else:
        winner = "TIE"
        reasoning = f"Equal scores ({score_a}). Chars: {chars_a} vs {chars_b}. Latency: {dur_a}ms vs {dur_b}ms."

    return {
        "winner": winner,
        "reasoning": reasoning,
        "scores": {"A": score_a, "B": score_b},
        "chars": {"A": chars_a, "B": chars_b},
        "duration_ms": {"A": dur_a, "B": dur_b},
        "estimated_tokens": {"A": int(chars_a / 4), "B": int(chars_b / 4)},
    }


# ---------------------------------------------------------------------------
# Single operation A/B test
# ---------------------------------------------------------------------------

def run_ab_operation(domain, operation, gateway, args, num_runs, output_dir):
    """Run num_runs A/B tests for a single operation. Returns list of run results."""
    op_key = f"{domain}.{operation}"
    op_dir = Path(output_dir) / domain / operation.replace(".", "_")
    op_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n  [{op_key}]")
    run_results = []

    for run_num in range(1, num_runs + 1):
        run_dir = op_dir / f"run-{run_num:03d}"
        run_dir.mkdir(parents=True, exist_ok=True)

        # Randomly assign MCP vs CLI to A and B (blind)
        a_is_mcp = random.choice([True, False])

        if a_is_mcp:
            # Side A = MCP, Side B = CLI
            a_success, a_chars, a_dur, a_resp = call_via_mcp(
                gateway, domain, operation,
                cleo_path=args.project_dir,
                seed_task=args.seed_task,
            )
            b_success, b_chars, b_dur, b_resp = call_via_cli(
                domain, operation, args.cleo,
                cwd=args.project_dir,
                seed_task=args.seed_task,
            )
        else:
            # Side A = CLI, Side B = MCP
            a_success, a_chars, a_dur, a_resp = call_via_cli(
                domain, operation, args.cleo,
                cwd=args.project_dir,
                seed_task=args.seed_task,
            )
            b_success, b_chars, b_dur, b_resp = call_via_mcp(
                gateway, domain, operation,
                cleo_path=args.project_dir,
                seed_task=args.seed_task,
            )

        comparison = blind_compare(a_resp, b_resp, operation, a_chars, b_chars, a_dur, b_dur)

        # De-blind: track which physical interface was A/B
        mcp_was_a = a_is_mcp
        mcp_chars = a_chars if a_is_mcp else b_chars
        cli_chars = b_chars if a_is_mcp else a_chars
        mcp_dur = a_dur if a_is_mcp else b_dur
        cli_dur = b_dur if a_is_mcp else a_dur

        winner_interface = "mcp" if (comparison["winner"] == "A") == a_is_mcp else \
                           "cli" if comparison["winner"] != "TIE" else "tie"

        run_result = {
            "run": run_num,
            "operation": op_key,
            "gateway": gateway,
            "a_is_mcp": a_is_mcp,
            "winner_label": comparison["winner"],
            "winner_interface": winner_interface,
            "comparison": comparison,
            "mcp": {
                "success": a_success if a_is_mcp else b_success,
                "output_chars": mcp_chars,
                "estimated_tokens": int(mcp_chars / 4),
                "duration_ms": mcp_dur,
            },
            "cli": {
                "success": b_success if a_is_mcp else a_success,
                "output_chars": cli_chars,
                "estimated_tokens": int(cli_chars / 4),
                "duration_ms": cli_dur,
            },
            "token_delta": int(mcp_chars / 4) - int(cli_chars / 4),
            "token_delta_pct": f"{((mcp_chars - cli_chars) / max(cli_chars, 1)) * 100:+.1f}%",
        }

        # Save run data
        (run_dir / "side-a" ).mkdir(exist_ok=True)
        (run_dir / "side-b").mkdir(exist_ok=True)
        (run_dir / "side-a" / "response.json").write_text(json.dumps(a_resp, indent=2))
        (run_dir / "side-b" / "response.json").write_text(json.dumps(b_resp, indent=2))
        (run_dir / "comparison.json").write_text(json.dumps(comparison, indent=2))
        (run_dir / "meta.json").write_text(json.dumps({
            "a_is_mcp": a_is_mcp,
            "winner_interface": winner_interface,
        }, indent=2))

        status = f"winner={comparison['winner']} ({winner_interface}) mcp={mcp_chars}c cli={cli_chars}c"
        print(f"    run {run_num}: {status}")
        run_results.append(run_result)

    # Save op-level summary
    wins = {"mcp": 0, "cli": 0, "tie": 0}
    for r in run_results:
        wins[r["winner_interface"]] = wins.get(r["winner_interface"], 0) + 1

    token_deltas = [r["token_delta"] for r in run_results]
    avg_delta = sum(token_deltas) / len(token_deltas) if token_deltas else 0

    op_summary = {
        "operation": op_key,
        "runs": num_runs,
        "wins": wins,
        "win_rate": {k: v / num_runs for k, v in wins.items()},
        "avg_token_delta_mcp_minus_cli": round(avg_delta, 1),
        "avg_mcp_chars": round(sum(r["mcp"]["output_chars"] for r in run_results) / num_runs, 0),
        "avg_cli_chars": round(sum(r["cli"]["output_chars"] for r in run_results) / num_runs, 0),
        "avg_mcp_ms": round(sum(r["mcp"]["duration_ms"] for r in run_results) / num_runs, 0),
        "avg_cli_ms": round(sum(r["cli"]["duration_ms"] for r in run_results) / num_runs, 0),
    }

    (op_dir / "summary.json").write_text(json.dumps(op_summary, indent=2))
    return run_results, op_summary


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="ct-grade v3 — Blind A/B test: CLEO MCP vs CLI")
    parser.add_argument("--domain", default=None, help="CLEO domain (e.g. tasks, session, admin)")
    parser.add_argument("--operations", default=None, help="Comma-separated operations (e.g. find,show,list)")
    parser.add_argument("--test-set", default=None,
                        choices=["smoke", "standard", "parity-P1", "parity-P2", "parity-P3", "parity"],
                        help="Predefined operation set")
    parser.add_argument("--tier", type=int, default=None, help="Filter by tier (0, 1, 2)")
    parser.add_argument("--gateway", default="query", choices=["query", "mutate"])
    parser.add_argument("--runs", type=int, default=3, help="Runs per operation (default: 3)")
    parser.add_argument("--cleo", default="cleo-dev", help="CLI binary")
    parser.add_argument("--project-dir", default=".", help="CLEO project root (for MCP server)")
    parser.add_argument("--output-dir", default=None, help="Output directory")
    parser.add_argument("--seed-task", default=None, help="Task ID for operations needing one")
    parser.add_argument("--params-json", default=None, help="Extra params as JSON")
    parser.add_argument("--json", action="store_true", help="Print summary JSON to stdout")
    args = parser.parse_args()

    # Build test matrix
    test_matrix = {}

    if args.test_set:
        test_matrix = OPERATION_SETS[args.test_set]
    elif args.domain and args.operations:
        ops = [o.strip() for o in args.operations.split(",")]
        test_matrix = {args.domain: ops}
    elif args.domain:
        # Default ops for the domain
        domain_defaults = {
            "tasks": ["find", "show", "list"],
            "session": ["status", "list"],
            "admin": ["dash", "health", "help"],
            "tools": ["skill.list"],
            "memory": ["find"],
            "check": ["health"],
            "pipeline": ["stage.status"],
            "orchestrate": ["status"],
            "nexus": ["status"],
            "sticky": ["list"],
        }
        test_matrix = {args.domain: domain_defaults.get(args.domain, ["find"])}
    else:
        print("ERROR: Provide --domain, --domain + --operations, or --test-set", file=sys.stderr)
        sys.exit(1)

    # Output directory
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    base_output = Path(args.output_dir) if args.output_dir else Path(f"./ab-results/{ts}")
    base_output.mkdir(parents=True, exist_ok=True)

    print(f"=== CLEO MCP vs CLI Blind A/B Test ===")
    print(f"  Domains   : {list(test_matrix.keys())}")
    print(f"  Runs/op   : {args.runs}")
    print(f"  Gateway   : {args.gateway}")
    print(f"  Output    : {base_output}")

    all_op_summaries = []
    all_run_results = []

    for domain, operations in test_matrix.items():
        for operation in operations:
            run_results, op_summary = run_ab_operation(
                domain, operation, args.gateway, args, args.runs, base_output
            )
            all_op_summaries.append(op_summary)
            all_run_results.extend(run_results)

    # Global summary
    total_mcp_wins = sum(s["wins"].get("mcp", 0) for s in all_op_summaries)
    total_cli_wins = sum(s["wins"].get("cli", 0) for s in all_op_summaries)
    total_ties = sum(s["wins"].get("tie", 0) for s in all_op_summaries)
    total_runs = len(all_run_results)
    avg_token_delta = sum(s["avg_token_delta_mcp_minus_cli"] for s in all_op_summaries) / max(len(all_op_summaries), 1)

    summary = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "test_matrix": {d: ops for d, ops in test_matrix.items()},
        "total_runs": total_runs,
        "global_wins": {
            "mcp": total_mcp_wins,
            "cli": total_cli_wins,
            "tie": total_ties,
        },
        "global_win_rate": {
            "mcp": round(total_mcp_wins / max(total_runs, 1), 3),
            "cli": round(total_cli_wins / max(total_runs, 1), 3),
        },
        "avg_token_delta_mcp_minus_cli": round(avg_token_delta, 1),
        "per_operation": {s["operation"]: s for s in all_op_summaries},
    }

    (base_output / "summary.json").write_text(json.dumps(summary, indent=2))

    print(f"\n=== Results ===")
    print(f"  Total runs : {total_runs}")
    print(f"  MCP wins   : {total_mcp_wins} ({summary['global_win_rate']['mcp']*100:.1f}%)")
    print(f"  CLI wins   : {total_cli_wins} ({summary['global_win_rate']['cli']*100:.1f}%)")
    print(f"  Ties       : {total_ties}")
    delta_sign = "+" if avg_token_delta > 0 else ""
    print(f"  Avg token delta (MCP-CLI): {delta_sign}{avg_token_delta:.1f} tokens")
    print(f"\nSaved: {base_output}")

    if args.json:
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
