"""
ct-grade v3 — Master Pipeline Runner

Orchestrates the full ct-grade v3 pipeline:
  1. Audit log analysis
  2. Scenario note (agents run separately via SKILL.md)
  3. A/B test
  4. Token tracker
  5. Report generation
  6. Grade review server

Usage:
    python scripts/run_all.py [--full] [--skip-ab] [--port 3118]
                              [--project-dir .] [--stop] [--no-browser]
"""

import argparse
import os
import signal
import subprocess
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
SKILL_DIR = SCRIPT_DIR.parent  # packages/skills/skills/ct-grade/


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------

def stop_server(project_dir: str) -> None:
    pid_file = Path(project_dir) / ".ct-grade-server.pid"
    if not pid_file.exists():
        print("No server PID file found. Server may not be running.")
        return
    pid = int(pid_file.read_text().strip())
    try:
        os.kill(pid, signal.SIGTERM)
        pid_file.unlink()
        print(f"Server stopped (PID {pid})")
    except ProcessLookupError:
        print(f"Process {pid} not found (already stopped)")
        pid_file.unlink()
    except Exception as e:
        print(f"Error stopping server: {e}")


def start_server(project_dir: str, output_dir: Path, port: int) -> int | None:
    """Step 6: Start grade review server in background."""
    viewer_script = SKILL_DIR / "eval-viewer" / "generate_grade_review.py"
    if not viewer_script.exists():
        print(
            f"  WARNING: Viewer script not found at {viewer_script}. Skipping server start."
        )
        return None

    print(f"\n[6/6] Starting Grade Review server on port {port}...")
    proc = subprocess.Popen(
        [
            sys.executable,
            str(viewer_script),
            str(project_dir),
            "--port",
            str(port),
            "--no-browser",
            "--ab-dir",
            str(output_dir),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,  # detach from parent
    )
    pid_file = Path(project_dir) / ".ct-grade-server.pid"
    pid_file.write_text(str(proc.pid))
    return proc.pid


# ---------------------------------------------------------------------------
# Pipeline steps
# ---------------------------------------------------------------------------

def step_audit_analyze(project_dir: str, output_dir: Path) -> None:
    """Step 1: Extract real per-op stats from tasks.db audit_log."""
    print("\n[1/6] Analyzing audit log...")
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_DIR / "audit_analyzer.py"),
            "--project-dir",
            str(project_dir),
            "--output-dir",
            str(output_dir),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"  WARNING: audit_analyzer failed: {result.stderr[:200]}")
    else:
        print("  Done.")


def step_scenario_note(full_mode: bool) -> None:
    """Step 2: Print info about scenario agents (not spawned here)."""
    print("\n[2/6] Scenario runners:")
    if full_mode:
        print(
            "  Full mode: S1–S5 scenarios are delegated to ct-grade scenario-runner agents."
        )
    else:
        print(
            "  Fast mode: S4+S5 scenarios are delegated to ct-grade scenario-runner agents."
        )
    print(
        "  Run scenarios separately via SKILL.md orchestration (skill invocation)."
    )


def step_ab_test(project_dir: str, output_dir: Path, full_mode: bool = False) -> None:
    """Step 3: Run A/B test (smoke in fast mode, parity in full mode)."""
    test_set = "parity" if full_mode else "smoke"
    runs = "3"
    print(f"\n[3/6] Running A/B test (--test-set {test_set}, --runs {runs})...")
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_DIR / "run_ab_test.py"),
            "--test-set",
            test_set,
            "--runs",
            runs,
            "--project-dir",
            str(project_dir),
            "--output-dir",
            str(output_dir / "ab-results"),
        ],
        capture_output=False,  # show live output
        text=True,
    )
    if result.returncode != 0:
        print("  WARNING: A/B test completed with errors.")


def step_token_tracker(project_dir: str, output_dir: Path, grades_file: Path) -> None:
    """Step 4: Enrich grade data with token estimates."""
    print("\n[4/6] Running token tracker...")
    args = [
        sys.executable,
        str(SCRIPT_DIR / "token_tracker.py"),
        "--project-dir",
        str(project_dir),
        "--output",
        str(output_dir / "token-summary.json"),
    ]
    if grades_file.exists():
        args += ["--grades-file", str(grades_file)]
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  WARNING: token_tracker failed: {result.stderr[:200]}")
    else:
        print("  Done.")


def step_generate_report(output_dir: Path) -> None:
    """Step 5: Generate markdown report."""
    print("\n[5/6] Generating report...")
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_DIR / "generate_report.py"),
            "--run-dir",
            str(output_dir),
            "--mode",
            "ab",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"  WARNING: generate_report failed: {result.stderr[:200]}")
    else:
        print(f"  Done. Report: {output_dir / 'report.md'}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="ct-grade v3 — Master Pipeline Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Run all 5 scenarios (S1–S5) + parity A/B tests. Default: fast mode (S4+S5 + smoke A/B).",
    )
    parser.add_argument(
        "--skip-ab",
        action="store_true",
        help="Skip the A/B test step.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=3118,
        help="Port for grade review server (default: 3118).",
    )
    parser.add_argument(
        "--project-dir",
        default=".",
        help="CLEO project root (default: current directory).",
    )
    parser.add_argument(
        "--stop",
        action="store_true",
        help="Kill existing server from .ct-grade-server.pid and exit.",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Don't auto-open browser after starting server.",
    )
    args = parser.parse_args()

    project_dir = str(Path(args.project_dir).resolve())

    # --stop: kill running server and exit
    if args.stop:
        stop_server(project_dir)
        return

    # Set up timestamped output directory
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir = Path(project_dir) / "ab-results" / timestamp
    output_dir.mkdir(parents=True, exist_ok=True)

    mode_label = "Full (S1–S5 + parity A/B)" if args.full else "Fast (S4+S5 + smoke A/B)"

    # Print header
    print("╔═══════════════════════════════════════╗")
    print("║   ct-grade v3 — Grade Review System   ║")
    print("╚═══════════════════════════════════════╝")
    print()
    print(f"  Mode     : {mode_label}")
    print(f"  Output   : ab-results/{timestamp}")
    print(f"  Project  : {project_dir}")

    grades_file = Path(project_dir) / ".cleo" / "metrics" / "GRADES.jsonl"

    # Step 1: Audit analysis
    step_audit_analyze(project_dir, output_dir)

    # Step 2: Scenario note
    step_scenario_note(args.full)

    # Step 3: A/B test (optional)
    if not args.skip_ab:
        step_ab_test(project_dir, output_dir, full_mode=args.full)
    else:
        print("\n[3/6] Skipping A/B test (--skip-ab).")

    # Step 4: Token tracker
    step_token_tracker(project_dir, output_dir, grades_file)

    # Step 5: Report generation
    step_generate_report(output_dir)

    # Step 6: Start server
    pid = start_server(project_dir, output_dir, args.port)

    # Open browser after brief pause for server to bind
    if not args.no_browser and pid is not None:
        time.sleep(0.5)
        webbrowser.open(f"http://localhost:{args.port}")

    print(f"\nGrade Review live at http://localhost:{args.port}")
    print("Stop with: python scripts/run_all.py --stop")


if __name__ == "__main__":
    main()
