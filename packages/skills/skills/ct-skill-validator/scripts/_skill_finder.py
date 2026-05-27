#!/usr/bin/env python3
"""Dynamic skill resolution — finds a sibling skill directory by name without
any hardcoded paths.

Search order (first match wins):

  1. $SKILL_FINDER_PATH environment variable — colon-separated override paths.
     Each entry is treated as a directory that may contain `<name>/SKILL.md`
     OR may itself be the skill directory if its basename matches.

  2. `~/.claude/skill-finder-paths.txt` — user config; newline-separated root
     directories to search. Useful when the install lives in `~/.claude/skills/`
     but the project skills live under `/mnt/projects/<repo>/skills/`.
     Lines starting with `#` are ignored.

  3. Sibling of the calling skill — `<this-skill>/../<name>/SKILL.md`.
     Most common in awesome-skills layouts where every skill is a peer.

  4. Two-up + `skills/<name>/` — `<this-skill>/../../skills/<name>/SKILL.md`.
     Matches cleocode `packages/skills/skills/...` and `repo/skills/...`.

  5. Walk up from the calling skill looking for a `skills/<name>/SKILL.md`
     on the ancestor chain AND its project-shaped children (depth-limited).

  6. `~/.claude/skills/<name>/SKILL.md` — installed Claude Code skill.

The caller is determined from `Path(__file__).resolve()` — so a skill
running its own script can find a peer without knowing absolute paths.

Use:
    from _skill_finder import find_skill
    evaluator = find_skill("skill-evaluator")
    if evaluator is None:
        sys.exit("skill-evaluator not found")

CLI:
    python _skill_finder.py <skill-name>      # prints path, exits 1 if not found
    python _skill_finder.py <skill-name> --json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Iterator


MAX_WALK_DEPTH = 6


def _candidates(name: str, caller_skill_dir: Path) -> Iterator[Path]:
    """Yield candidate paths in priority order. Each may or may not exist."""

    # 1. Explicit override via env var (colon-separated paths)
    env = os.environ.get("SKILL_FINDER_PATH", "")
    for entry in (e for e in env.split(":") if e):
        p = Path(entry).expanduser()
        # If the entry IS the skill directory, accept it; else treat as parent
        if p.is_dir() and p.name == name and (p / "SKILL.md").exists():
            yield p
            continue
        yield p / name
        # Also probe common "skills/" subdirs under each user-configured root
        yield p / "skills" / name
        yield p / "packages" / "skills" / "skills" / name

    # 2. User config file: ~/.claude/skill-finder-paths.txt
    cfg = Path.home() / ".claude" / "skill-finder-paths.txt"
    if cfg.exists():
        try:
            for line in cfg.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                root = Path(line).expanduser()
                yield root / name
                yield root / "skills" / name
                yield root / "packages" / "skills" / "skills" / name
                # Also peek into project-shaped children of the root
                if root.is_dir():
                    try:
                        for child in root.iterdir():
                            if not child.is_dir() or child.name.startswith("."):
                                continue
                            if (child / "skills").is_dir():
                                yield child / "skills" / name
                            if (child / "packages" / "skills" / "skills").is_dir():
                                yield child / "packages" / "skills" / "skills" / name
                    except PermissionError:
                        pass
        except (OSError, UnicodeDecodeError):
            pass

    # 3. Direct sibling of the caller
    yield caller_skill_dir.parent / name

    # 4. Two-up + skills/<name>/
    yield caller_skill_dir.parent.parent / "skills" / name

    # 4. Walk up looking for skills/<name>/ on the ancestor chain.
    #    At each ancestor `cur`, probe:
    #      - cur/skills/<name>                         (standard layout)
    #      - cur/packages/skills/skills/<name>         (CLEO layout)
    #    AND iterate the *children* of cur (which are potential project
    #    roots) and probe:
    #      - <child>/skills/<name>
    #      - <child>/packages/skills/skills/<name>
    #    This finds skills under sibling project roots — e.g. when the
    #    caller is in /mnt/projects/cleocode/.../ct-skill-validator/ and
    #    the target is in /mnt/projects/proxmox/skills/<name>/. The walk
    #    eventually reaches the common ancestor /mnt/projects/ where both
    #    cleocode and proxmox are children. Bounded by MAX_SIBLINGS per
    #    level to keep this fast on populated roots.
    cur = caller_skill_dir.parent
    for _ in range(MAX_WALK_DEPTH):
        yield cur / "skills" / name
        yield cur / "packages" / "skills" / "skills" / name
        # Iterate children, pre-filtering to project-shaped dirs only.
        # A project-shaped dir is one that has a `skills/` or
        # `packages/skills/skills/` subdir on disk. The pre-filter is one
        # extra stat per child but eliminates the vast majority of irrelevant
        # candidates before they enter the search, keeping a fully-populated
        # ancestor (e.g. 200+ peer projects) sub-second.
        if cur.is_dir():
            try:
                for child in cur.iterdir():
                    if not child.is_dir() or child.name.startswith("."):
                        continue
                    if (child / "skills").is_dir():
                        yield child / "skills" / name
                    if (child / "packages" / "skills" / "skills").is_dir():
                        yield child / "packages" / "skills" / "skills" / name
            except PermissionError:
                pass
        parent = cur.parent
        if parent == cur:
            break
        cur = parent

    # 5. Installed Claude Code skill
    yield Path.home() / ".claude" / "skills" / name


def caller_skill_dir() -> Path:
    """Resolve the directory of the skill that invoked this helper.

    Assumes this file lives at `<skill>/scripts/_skill_finder.py`. If moved,
    the caller can pass `caller_skill_dir` to `find_skill()` explicitly.
    """
    return Path(__file__).resolve().parent.parent


def find_skill(name: str, *, caller: Path | None = None) -> Path | None:
    """Return the resolved path of the named skill, or None if not found.

    A skill is considered found if `<candidate>/SKILL.md` exists.
    """
    caller_dir = (caller or caller_skill_dir()).resolve()
    seen: set[Path] = set()
    for cand in _candidates(name, caller_dir):
        try:
            resolved = cand.resolve()
        except (OSError, RuntimeError):
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        if (resolved / "SKILL.md").exists():
            return resolved
    return None


def find_first(names: list[str], *, caller: Path | None = None) -> tuple[str, Path] | None:
    """Return the (name, path) of the first found skill from a preference list.

    Lets callers say "prefer skill-evaluator, fall back to ct-skill-creator"
    without hardcoding either path.
    """
    for n in names:
        p = find_skill(n, caller=caller)
        if p is not None:
            return n, p
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("name", help="skill name to resolve")
    ap.add_argument("--caller", help="override the calling-skill directory")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of bare path")
    args = ap.parse_args()

    caller = Path(args.caller).expanduser().resolve() if args.caller else None
    path = find_skill(args.name, caller=caller)

    if args.json:
        print(json.dumps({"name": args.name, "found": path is not None,
                          "path": str(path) if path else None}, indent=2))
    else:
        if path is None:
            print(f"error: skill '{args.name}' not found on search path", file=sys.stderr)
            return 1
        print(str(path))
    return 0 if path is not None else 1


if __name__ == "__main__":
    sys.exit(main())
