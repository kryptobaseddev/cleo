#!/usr/bin/env python3
"""Phase 3 dispatcher — delegates runtime quality eval to a dedicated skill.

Prefers `skill-evaluator` (the dedicated quality-eval skill) and falls back
to `ct-skill-creator` (legacy eval infrastructure) when skill-evaluator
isn't found. Uses `_skill_finder.py` to resolve the target dynamically —
no hardcoded cross-skill paths.

Usage:
    run_quality_eval.py <skill-dir>             # full quality eval
    run_quality_eval.py <skill-dir> --trigger   # trigger-accuracy only
    run_quality_eval.py <skill-dir> --runs 3 --executor api
    run_quality_eval.py --list                  # show what's reachable

Exit codes:
    0  — eval ran (or was prepared, in --executor print mode)
    1  — target eval skill not found on the search path
    2  — eval script inside the target skill exited non-zero
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _skill_finder import find_first  # noqa: E402


# Preference order — first found wins. Lets the user opt-in to a different
# eval skill via $SKILL_FINDER_PATH without code changes.
PREFERENCE = ["skill-evaluator", "ct-skill-creator"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("skill_dir", nargs="?", help="path to the skill being evaluated")
    ap.add_argument("--trigger", action="store_true",
                    help="run trigger-accuracy eval only (description_eval.py)")
    ap.add_argument("--runs", type=int, default=3, help="repeated runs per case")
    ap.add_argument("--executor", default=None,
                    help="executor for the eval (passes through to the target script)")
    ap.add_argument("--list", action="store_true",
                    help="show what eval skill would be used and exit")
    ap.add_argument("--evals", default=None, help="explicit evals.json path")
    args, extra = ap.parse_known_args()

    resolved = find_first(PREFERENCE)
    if resolved is None:
        print(
            f"error: none of {PREFERENCE} were found on the search path. "
            f"Set SKILL_FINDER_PATH or install one of them.",
            file=sys.stderr,
        )
        return 1
    eval_skill_name, eval_skill_path = resolved

    if args.list:
        print(f"will use: {eval_skill_name} at {eval_skill_path}")
        return 0

    if not args.skill_dir:
        ap.error("skill_dir is required unless --list is given")

    target_skill = Path(args.skill_dir).expanduser().resolve()
    if not (target_skill / "SKILL.md").exists():
        print(f"error: '{args.skill_dir}' is not a skill directory (no SKILL.md)",
              file=sys.stderr)
        return 1

    # Pick the right script per target eval skill
    if eval_skill_name == "skill-evaluator":
        if args.trigger:
            script = eval_skill_path / "scripts" / "description_eval.py"
            cmd = ["python3", str(script), "--skill", str(target_skill), "--runs", str(args.runs)]
        else:
            script = eval_skill_path / "scripts" / "run_eval.py"
            cmd = ["python3", str(script), "--skill", str(target_skill), "--runs", str(args.runs)]
            if args.evals:
                cmd += ["--evals", args.evals]
        if args.executor:
            cmd += ["--executor", args.executor]
    else:
        # ct-skill-creator legacy paths
        if args.trigger:
            script = eval_skill_path / "scripts" / "run_eval.py"
            cmd = ["python3", str(script), "--skill-path", str(target_skill)]
            if args.evals:
                cmd += ["--eval-set", args.evals]
        else:
            script = eval_skill_path / "scripts" / "run_eval.py"
            cmd = ["python3", str(script), "--skill-path", str(target_skill)]
            if args.evals:
                cmd += ["--eval-set", args.evals]

    if not script.exists():
        print(f"error: expected script not found: {script}", file=sys.stderr)
        return 1

    cmd += extra  # pass any additional flags straight through
    print(f"[run_quality_eval] dispatching to {eval_skill_name}: {' '.join(cmd)}",
          file=sys.stderr)
    rc = subprocess.run(cmd).returncode
    return 0 if rc == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
